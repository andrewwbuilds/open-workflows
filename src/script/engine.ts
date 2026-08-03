import type { SessionRunner } from "../runtime/types.js"
import { parseWorkflowScript, type WorkflowMeta } from "./meta.js"
import {
  buildSchemaInstruction,
  buildSchemaRetryPrompt,
  parseWithSchema,
  type JsonSchemaLike,
} from "./schema.js"

export interface AgentCallOptions {
  label?: string
  phase?: string
  schema?: JsonSchemaLike
  model?: string
  agentType?: string
  /** Accepted for Claude Code script compatibility; OpenCode has no equivalent. */
  effort?: string
  /** Accepted for Claude Code script compatibility; OpenCode has no equivalent. */
  isolation?: string
}

export interface ScriptAgentEvent {
  id: number
  label: string
  phase?: string
}

export interface WorkflowScriptEvents {
  onPhase?: (title: string) => void
  onLog?: (message: string) => void
  onAgentStart?: (event: ScriptAgentEvent) => void
  onAgentEnd?: (event: ScriptAgentEvent & { ok: boolean }) => void
}

export interface RunWorkflowScriptInput {
  script: string
  args?: unknown
  runner: SessionRunner
  abort?: AbortSignal
  /** OpenCode agent used for agent() calls unless opts.agentType overrides it. */
  defaultAgent: string
  /** Default "provider/model" override for child sessions. */
  model?: string
  /** Max concurrently-running agent() calls. */
  concurrency?: number
  /** Hard output-token ceiling for budget.remaining(); null means unlimited. */
  budgetTokens?: number | null
  maxAgents?: number
  maxItems?: number
  schemaRetries?: number
  events?: WorkflowScriptEvents
}

export interface WorkflowScriptResult {
  meta: WorkflowMeta
  value: unknown
  logs: string[]
  phases: string[]
  agentCount: number
  tokensSpent: number
  sessionIDs: string[]
}

const DEFAULT_CONCURRENCY = 8
const DEFAULT_MAX_AGENTS = 1000
const DEFAULT_MAX_ITEMS = 4096
const DEFAULT_SCHEMA_RETRIES = 2

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...args: string[]
) => (...hookValues: unknown[]) => Promise<unknown>

export async function runWorkflowScript(input: RunWorkflowScriptInput): Promise<WorkflowScriptResult> {
  const { meta, body } = parseWorkflowScript(input.script)
  const concurrency = Math.max(1, input.concurrency ?? DEFAULT_CONCURRENCY)
  const maxAgents = input.maxAgents ?? DEFAULT_MAX_AGENTS
  const maxItems = input.maxItems ?? DEFAULT_MAX_ITEMS
  const schemaRetries = input.schemaRetries ?? DEFAULT_SCHEMA_RETRIES
  const budgetTotal = input.budgetTokens ?? null

  const logs: string[] = []
  const phases: string[] = []
  const sessionIDs: string[] = []
  const semaphore = createSemaphore(concurrency)
  // Internal controller so a script failure also cancels in-flight agents;
  // it mirrors the caller's signal when one is provided.
  const controller = new AbortController()
  if (input.abort?.aborted) controller.abort()
  input.abort?.addEventListener("abort", () => controller.abort(), { once: true })
  const signal = controller.signal
  let currentPhase: string | undefined
  let agentCount = 0
  let tokensSpent = 0

  const budget = {
    get total() {
      return budgetTotal
    },
    spent: () => tokensSpent,
    remaining: () => (budgetTotal === null ? Infinity : Math.max(0, budgetTotal - tokensSpent)),
  }

  const phase = (title: string): void => {
    if (typeof title !== "string" || title.trim() === "") return
    currentPhase = title
    phases.push(title)
    input.events?.onPhase?.(title)
  }

  const log = (message: string): void => {
    const text = String(message)
    logs.push(text)
    input.events?.onLog?.(text)
  }

  const agent = async (prompt: string, opts: AgentCallOptions = {}): Promise<unknown> => {
    if (typeof prompt !== "string" || prompt.trim() === "") {
      throw new Error("agent() requires a non-empty prompt string.")
    }
    const release = await semaphore.acquire()
    // Checks run after the semaphore so queued calls see up-to-date abort
    // state and token spend, not the values from when they were enqueued.
    if (signal.aborted) {
      release()
      throw new WorkflowAbortError()
    }
    if (budgetTotal !== null && tokensSpent >= budgetTotal) {
      release()
      throw new WorkflowLimitError(
        `Token budget exhausted: spent ${tokensSpent} of ${budgetTotal} output tokens.`,
      )
    }
    agentCount += 1
    if (agentCount > maxAgents) {
      release()
      throw new WorkflowLimitError(`Workflow exceeded the ${maxAgents}-agent lifetime cap.`)
    }
    const id = agentCount
    const label = opts.label ?? truncate(prompt.replace(/\s+/g, " ").trim(), 50)
    const agentPhase = opts.phase ?? currentPhase
    const event: ScriptAgentEvent = { id, label, phase: agentPhase }

    input.events?.onAgentStart?.(event)
    try {
      const session = await input.runner.createChildSession({
        title: label,
        agent: opts.agentType ?? input.defaultAgent,
        model: opts.model ?? input.model,
      })
      sessionIDs.push(session.sessionID)
      const fullPrompt = opts.schema ? prompt + buildSchemaInstruction(opts.schema) : prompt
      let result = await input.runner.runChildSession({
        sessionID: session.sessionID,
        agent: opts.agentType ?? input.defaultAgent,
        model: opts.model ?? input.model,
        prompt: fullPrompt,
        abort: signal,
      })
      tokensSpent += result.tokens?.output ?? 0
      if (result.error) {
        input.events?.onAgentEnd?.({ ...event, ok: false })
        return null
      }
      if (!opts.schema) {
        input.events?.onAgentEnd?.({ ...event, ok: true })
        return result.text
      }
      let parsed = parseWithSchema(result.text, opts.schema)
      let attempts = 0
      while (!parsed.ok && attempts < schemaRetries) {
        attempts += 1
        result = await input.runner.runChildSession({
          sessionID: session.sessionID,
          agent: opts.agentType ?? input.defaultAgent,
          model: opts.model ?? input.model,
          prompt: buildSchemaRetryPrompt(parsed.error ?? "invalid JSON", opts.schema),
          abort: signal,
        })
        tokensSpent += result.tokens?.output ?? 0
        if (result.error) break
        parsed = parseWithSchema(result.text, opts.schema)
      }
      input.events?.onAgentEnd?.({ ...event, ok: parsed.ok })
      return parsed.ok ? parsed.value : null
    } catch (error) {
      input.events?.onAgentEnd?.({ ...event, ok: false })
      if (signal.aborted) {
        throw error instanceof WorkflowAbortError ? error : new WorkflowAbortError()
      }
      return null
    } finally {
      release()
    }
  }

  const parallel = async (thunks: Array<() => Promise<unknown>>): Promise<unknown[]> => {
    if (!Array.isArray(thunks)) {
      throw new Error("parallel() requires an array of zero-argument functions.")
    }
    if (thunks.length > maxItems) {
      throw new Error(`parallel() accepts at most ${maxItems} items, got ${thunks.length}.`)
    }
    return Promise.all(
      thunks.map((thunk) =>
        Promise.resolve()
          .then(() => thunk())
          .catch((error: unknown) => {
            // Ordinary thunk failures become null; cancellation must still
            // terminate the workflow instead of degrading to a null item.
            if (error instanceof WorkflowAbortError || signal.aborted) throw error
            return null
          }),
      ),
    )
  }

  type PipelineStage = (prev: unknown, item: unknown, index: number) => unknown

  const pipeline = async (items: unknown[], ...stages: PipelineStage[]): Promise<unknown[]> => {
    if (!Array.isArray(items)) {
      throw new Error("pipeline() requires an array of items as its first argument.")
    }
    if (items.length > maxItems) {
      throw new Error(`pipeline() accepts at most ${maxItems} items, got ${items.length}.`)
    }
    return Promise.all(
      items.map(async (item, index) => {
        let value: unknown = item
        for (const stage of stages) {
          try {
            value = await stage(value, item, index)
          } catch (error) {
            if (error instanceof WorkflowAbortError || signal.aborted) throw error
            return null
          }
        }
        return value
      }),
    )
  }

  const workflow = (): never => {
    throw new Error("Nested workflow() calls are not supported by open-workflows yet.")
  }

  let value: unknown
  try {
    const run = new AsyncFunction(
      "agent",
      "parallel",
      "pipeline",
      "phase",
      "log",
      "args",
      "budget",
      "workflow",
      body,
    )
    value = await run(agent, parallel, pipeline, phase, log, input.args, budget, workflow)
  } catch (error) {
    // Cancel any agents the script left in flight so they stop consuming
    // sessions and tokens after the failure is reported.
    controller.abort()
    throw new WorkflowScriptError(message(error), {
      meta,
      value: undefined,
      logs,
      phases,
      agentCount,
      tokensSpent,
      sessionIDs,
    })
  }

  return { meta, value, logs, phases, agentCount, tokensSpent, sessionIDs }
}

/** Thrown by agent() when the workflow is cancelled; never converted to null. */
export class WorkflowAbortError extends Error {
  constructor() {
    super("Workflow aborted.")
    this.name = "WorkflowAbortError"
  }
}

export class WorkflowScriptError extends Error {
  readonly partial: WorkflowScriptResult

  constructor(msg: string, partial: WorkflowScriptResult) {
    super(msg)
    this.name = "WorkflowScriptError"
    this.partial = partial
  }
}

function createSemaphore(limit: number): { acquire(): Promise<() => void> } {
  let active = 0
  const waiters: Array<() => void> = []
  const next = (): void => {
    if (active < limit && waiters.length > 0) {
      active += 1
      const waiter = waiters.shift()
      waiter?.()
    }
  }
  return {
    acquire() {
      return new Promise<() => void>((resolve) => {
        const grant = (): void => {
          let released = false
          resolve(() => {
            if (released) return
            released = true
            active -= 1
            next()
          })
        }
        waiters.push(grant)
        next()
      })
    },
  }
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value
  return value.slice(0, max - 1) + "…"
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

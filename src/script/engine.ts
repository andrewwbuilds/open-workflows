import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { cpus, homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import type { SessionRunner } from "../runtime/types.js"
import {
  createJournalWriter,
  createReplayState,
  generateRunId,
  hashAgentCall,
  hashScript,
  loadJournalEntries,
  type JournalWriter,
  type ReplayState,
} from "./journal.js"
import { parseWorkflowScript, type WorkflowMeta } from "./meta.js"
import {
  buildSchemaInstruction,
  buildSchemaRetryPrompt,
  parseWithSchema,
  type JsonSchemaLike,
} from "./schema.js"

const execFileAsync = promisify(execFile)

export interface AgentCallOptions {
  label?: string
  phase?: string
  schema?: JsonSchemaLike
  model?: string
  agentType?: string
  /** Accepted for Claude Code script compatibility; OpenCode has no equivalent. */
  effort?: string
  /**
   * "worktree" runs the agent in a fresh git worktree of the workflow's
   * working directory so parallel file-mutating agents cannot conflict.
   * Other values are accepted for Claude Code script compatibility and ignored.
   */
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
  /** Directory the workflow runs in; required for agent() worktree isolation. */
  workingDirectory?: string
  /** Hard output-token ceiling for budget.remaining(); null means unlimited. */
  budgetTokens?: number | null
  maxAgents?: number
  maxItems?: number
  schemaRetries?: number
  events?: WorkflowScriptEvents
  /**
   * Run id for this run's journal; generated (outside the script sandbox) when
   * omitted. Journaling requires `workingDirectory` to be set.
   */
  runId?: string
  /**
   * Resume from a prior run's journal: agent() calls matching that journal's
   * unchanged (seq, hash) prefix return the journaled result without spawning
   * a session; the first mismatch switches the run permanently to live mode.
   */
  resumeFromRunId?: string
  /**
   * @internal Parent orchestration state borrowed when running as a nested
   * workflow() child; when set, concurrency/budgetTokens/maxAgents are ignored.
   */
  sharedState?: WorkflowSharedState
  /** @internal Nesting depth: 0 for a top-level run, 1 inside workflow(). */
  nestingDepth?: number
}

/**
 * Mutable orchestration state shared between a workflow and the workflow()
 * children it spawns: one concurrency semaphore, one lifetime agent counter,
 * and one token budget, so a child cannot escape the parent's limits.
 */
export interface WorkflowSharedState {
  semaphore: { acquire(): Promise<() => void> }
  budgetTotal: number | null
  maxAgents: number
  agentCount: number
  tokensSpent: number
  /** Journal for this run; agent() calls from nested workflow() children share it. */
  journal?: JournalWriter
  /** Replay cursor when resuming from a prior run's journal. */
  replay?: ReplayState
}

export interface WorkflowScriptResult {
  meta: WorkflowMeta
  runId: string
  value: unknown
  logs: string[]
  phases: string[]
  agentCount: number
  tokensSpent: number
  sessionIDs: string[]
}

/**
 * Concurrent agent() calls are capped at min(16, cpu cores - 2), matching
 * Claude Code's workflow default. Excess calls queue on the semaphore and run
 * as slots free up, so a 100-item parallel()/pipeline() still completes.
 */
export const DEFAULT_CONCURRENCY = Math.min(16, Math.max(1, cpus().length - 2))
const DEFAULT_MAX_AGENTS = 1000
const DEFAULT_MAX_ITEMS = 4096
const DEFAULT_SCHEMA_RETRIES = 2

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...args: string[]
) => (...hookValues: unknown[]) => Promise<unknown>

function nondeterministic(what: string, hint: string): never {
  throw new Error(
    `${what} is not available inside workflow scripts: results must be deterministic so resume replay works. ${hint}`,
  )
}

/**
 * `Date` shadow for workflow scripts: reading the current time is
 * nondeterministic, so argless construction, `Date.now()`, and calling
 * `Date()` as a function all throw. Everything else - `new Date(value)`,
 * `instanceof Date`, `Date.parse`, `Date.UTC`, prototype methods - behaves
 * identically because the proxy forwards to the real constructor.
 */
const deterministicDate = new Proxy(Date, {
  construct(target, argArray, newTarget) {
    if (argArray.length === 0) {
      nondeterministic(
        "new Date() without arguments",
        "Pass the timestamp in via args (e.g. new Date(args.now)).",
      )
    }
    return Reflect.construct(target, argArray, newTarget)
  },
  apply() {
    nondeterministic(
      "Date() called as a function",
      "Pass the timestamp in via args (e.g. args.now).",
    )
  },
  get(target, property, receiver) {
    if (property === "now") {
      return (): never =>
        nondeterministic("Date.now()", "Pass the timestamp in via args (e.g. args.now).")
    }
    return Reflect.get(target, property, receiver)
  },
})

/**
 * `Math` shadow for workflow scripts: a clone of the real Math object whose
 * `random()` throws. Math's own properties are non-enumerable, so the clone
 * copies property descriptors rather than using object spread.
 */
const deterministicMath = Object.defineProperties({}, {
  ...Object.getOwnPropertyDescriptors(Math),
  random: {
    value: (): never =>
      nondeterministic("Math.random()", "Pass random values or a seed in via args (e.g. args.seed)."),
    writable: false,
    enumerable: false,
    configurable: false,
  },
}) as Math

export async function runWorkflowScript(input: RunWorkflowScriptInput): Promise<WorkflowScriptResult> {
  const { meta, body } = parseWorkflowScript(input.script)
  const maxItems = input.maxItems ?? DEFAULT_MAX_ITEMS
  const schemaRetries = input.schemaRetries ?? DEFAULT_SCHEMA_RETRIES
  const depth = input.nestingDepth ?? 0
  // A workflow() child borrows the parent's state so its agents queue on the
  // same semaphore and count against the same lifetime cap and token budget.
  const shared: WorkflowSharedState = input.sharedState ?? {
    semaphore: createSemaphore(Math.max(1, input.concurrency ?? DEFAULT_CONCURRENCY)),
    budgetTotal: input.budgetTokens ?? null,
    maxAgents: input.maxAgents ?? DEFAULT_MAX_AGENTS,
    agentCount: 0,
    tokensSpent: 0,
  }

  // The run id is minted here, outside the script sandbox, so scripts stay
  // deterministic. Only the top-level run owns a journal; workflow() children
  // append to it through the shared state.
  const runId = input.runId ?? generateRunId()
  if (!input.sharedState) {
    if (input.resumeFromRunId) {
      if (!input.workingDirectory) {
        throw new Error("resumeFromRunId requires a working directory to load the journal from.")
      }
      shared.replay = createReplayState(
        await loadJournalEntries(input.workingDirectory, input.resumeFromRunId),
      )
    }
    if (input.workingDirectory) {
      shared.journal = await createJournalWriter(input.workingDirectory, {
        runId,
        scriptHash: hashScript(input.script),
        meta,
      })
    }
  }

  const logs: string[] = []
  const phases: string[] = []
  const sessionIDs: string[] = []
  // Internal controller so a script failure also cancels in-flight agents;
  // it mirrors the caller's signal when one is provided.
  const controller = new AbortController()
  if (input.abort?.aborted) controller.abort()
  input.abort?.addEventListener("abort", () => controller.abort(), { once: true })
  const signal = controller.signal
  let currentPhase: string | undefined

  const budget = {
    get total() {
      return shared.budgetTotal
    },
    spent: () => shared.tokensSpent,
    remaining: () =>
      shared.budgetTotal === null ? Infinity : Math.max(0, shared.budgetTotal - shared.tokensSpent),
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
    // seq is assigned at invocation in call order so resume replay can match
    // journaled calls positionally; cached replays still count toward the
    // lifetime cap even though they never spawn a session.
    shared.agentCount += 1
    const seq = shared.agentCount
    if (seq > shared.maxAgents) {
      throw new Error(`Workflow exceeded the ${shared.maxAgents}-agent lifetime cap.`)
    }
    const label = opts.label ?? truncate(prompt.replace(/\s+/g, " ").trim(), 50)
    const agentPhase = opts.phase ?? currentPhase
    // Model resolution: per-call override, then the phase's declared model
    // from meta.phases, then the workflow-wide default.
    const phaseModel = agentPhase
      ? meta.phases?.find((entry) => entry.title === agentPhase)?.model
      : undefined
    const agentModel = opts.model ?? phaseModel ?? input.model
    const event: ScriptAgentEvent = { id: seq, label, phase: agentPhase }
    const hash = hashAgentCall(prompt, opts as Record<string, unknown>)
    const journalResult = (result: unknown): void => {
      shared.journal?.append({ seq, hash, label, phase: agentPhase, result })
    }

    if (signal.aborted) throw new WorkflowAbortError()
    const cached = shared.replay?.take(seq, hash)
    if (cached) {
      // Journaled replay: no session spawned, no token spend; events still
      // fire, and the entry is re-journaled so this run is itself resumable.
      input.events?.onAgentStart?.(event)
      input.events?.onAgentEnd?.({ ...event, ok: cached.result !== null })
      journalResult(cached.result)
      return cached.result
    }

    const release = await shared.semaphore.acquire()
    // Checks run after the semaphore so queued calls see up-to-date abort
    // state and token spend, not the values from when they were enqueued.
    if (signal.aborted) {
      release()
      throw new WorkflowAbortError()
    }
    if (shared.budgetTotal !== null && shared.tokensSpent >= shared.budgetTotal) {
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

    const runSession = async (directory?: string): Promise<unknown> => {
      const session = await input.runner.createChildSession({
        title: label,
        agent: opts.agentType ?? input.defaultAgent,
        model: agentModel,
        directory,
      })
      sessionIDs.push(session.sessionID)
      const fullPrompt = opts.schema ? prompt + buildSchemaInstruction(opts.schema) : prompt
      let result = await input.runner.runChildSession({
        sessionID: session.sessionID,
        agent: opts.agentType ?? input.defaultAgent,
        model: agentModel,
        prompt: fullPrompt,
        abort: signal,
        directory,
      })
      shared.tokensSpent += result.tokens?.output ?? 0
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
          model: agentModel,
          prompt: buildSchemaRetryPrompt(parsed.error ?? "invalid JSON", opts.schema),
          abort: signal,
          directory,
        })
        shared.tokensSpent += result.tokens?.output ?? 0
        if (result.error) break
        parsed = parseWithSchema(result.text, opts.schema)
      }
      input.events?.onAgentEnd?.({ ...event, ok: parsed.ok })
      return parsed.ok ? parsed.value : null
    }

    input.events?.onAgentStart?.(event)
    const root = input.workingDirectory
    let worktree: string | undefined
    try {
      if (opts.isolation === "worktree") {
        if (!root) {
          log(`agent "${label}": worktree isolation requested but no working directory is configured; running without isolation.`)
        } else if (!(await isGitRepository(root))) {
          log(`agent "${label}": worktree isolation requested but ${root} is not a git repository; running without isolation.`)
        } else {
          worktree = await addWorktree(root)
        }
      }
      let value = await runSession(worktree)
      if (worktree && root) {
        const removed = await removeWorktreeIfClean(root, worktree)
        if (!removed) {
          log(`agent "${label}" left changes in worktree ${worktree}; harvest them from that path.`)
          if (typeof value === "string") {
            value = `${value}\n\n[worktree with changes preserved at: ${worktree}]`
          }
        }
      }
      journalResult(value)
      return value
    } catch (error) {
      if (worktree && root) {
        const removed = await removeWorktreeIfClean(root, worktree)
        if (!removed) {
          log(`agent "${label}" failed but left changes in worktree ${worktree}; harvest them from that path.`)
        }
      }
      input.events?.onAgentEnd?.({ ...event, ok: false })
      if (signal.aborted) {
        throw error instanceof WorkflowAbortError ? error : new WorkflowAbortError()
      }
      journalResult(null)
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

  const workflow = async (nameOrRef: unknown, childArgs?: unknown): Promise<unknown> => {
    if (depth >= 1) {
      throw new Error("Nesting is one level only")
    }
    const script = await loadChildWorkflowScript(nameOrRef, input.workingDirectory)
    const child = await runWorkflowScript({
      script,
      args: childArgs,
      runner: input.runner,
      abort: signal,
      defaultAgent: input.defaultAgent,
      model: input.model,
      workingDirectory: input.workingDirectory,
      maxItems: input.maxItems,
      schemaRetries: input.schemaRetries,
      events: input.events,
      sharedState: shared,
      nestingDepth: depth + 1,
    })
    sessionIDs.push(...child.sessionIDs)
    return child.value
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
      "Date",
      "Math",
      body,
    )
    value = await run(
      agent,
      parallel,
      pipeline,
      phase,
      log,
      input.args,
      budget,
      workflow,
      deterministicDate,
      deterministicMath,
    )
  } catch (error) {
    // Cancel any agents the script left in flight so they stop consuming
    // sessions and tokens after the failure is reported.
    controller.abort()
    await shared.journal?.flush()
    throw new WorkflowScriptError(message(error), {
      meta,
      runId,
      value: undefined,
      logs,
      phases,
      agentCount: shared.agentCount,
      tokensSpent: shared.tokensSpent,
      sessionIDs,
    })
  }

  await shared.journal?.flush()
  return {
    meta,
    runId,
    value,
    logs,
    phases,
    agentCount: shared.agentCount,
    tokensSpent: shared.tokensSpent,
    sessionIDs,
  }
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

/**
 * Resolve the script for a workflow() call: a string is a saved workflow name
 * looked up under `<workingDirectory>/.opencode/workflows/<name>.js` then
 * `~/.config/opencode/workflows/<name>.js`; `{ scriptPath }` reads that file.
 */
async function loadChildWorkflowScript(
  nameOrRef: unknown,
  workingDirectory: string | undefined,
): Promise<string> {
  if (typeof nameOrRef === "string") {
    const name = nameOrRef.trim()
    if (name === "" || name.includes("/") || name.includes("\\") || name.includes("..")) {
      throw new Error(`workflow() requires a plain workflow name or { scriptPath }; got "${nameOrRef}".`)
    }
    const candidates = savedWorkflowPaths(name, workingDirectory)
    for (const candidate of candidates) {
      const script = await readScriptFile(candidate)
      if (script !== undefined) return script
    }
    throw new Error(`Unknown workflow "${name}". Looked for ${candidates.join(", ")}.`)
  }
  if (
    typeof nameOrRef === "object" &&
    nameOrRef !== null &&
    typeof (nameOrRef as { scriptPath?: unknown }).scriptPath === "string"
  ) {
    const scriptPath = (nameOrRef as { scriptPath: string }).scriptPath
    const script = await readScriptFile(scriptPath)
    if (script === undefined) {
      throw new Error(`workflow() could not read the script at ${scriptPath}.`)
    }
    return script
  }
  throw new Error("workflow() requires a saved workflow name or { scriptPath }.")
}

function savedWorkflowPaths(name: string, workingDirectory: string | undefined): string[] {
  const paths: string[] = []
  if (workingDirectory) paths.push(join(workingDirectory, ".opencode", "workflows", `${name}.js`))
  paths.push(join(homedir(), ".config", "opencode", "workflows", `${name}.js`))
  return paths
}

async function readScriptFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8")
  } catch {
    return undefined
  }
}

async function isGitRepository(directory: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["-C", directory, "rev-parse", "--git-dir"])
    return true
  } catch {
    return false
  }
}

/** Create a detached-HEAD worktree of `directory` in a fresh temp dir. */
async function addWorktree(directory: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "open-workflows-wt-"))
  try {
    await execFileAsync("git", ["-C", directory, "worktree", "add", path, "HEAD"])
    return path
  } catch (error) {
    await rm(path, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

/**
 * Remove an isolation worktree only when `git status --porcelain` reports no
 * changes; a dirty (or unreadable) worktree is kept so the caller can harvest
 * the agent's edits from it. Returns whether the worktree was removed.
 */
async function removeWorktreeIfClean(directory: string, worktree: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", worktree, "status", "--porcelain"])
    if (stdout.trim() !== "") return false
    await execFileAsync("git", ["-C", directory, "worktree", "remove", "--force", worktree])
    return true
  } catch {
    return false
  }
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value
  return value.slice(0, max - 1) + "…"
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

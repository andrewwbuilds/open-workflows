import { execFile } from "node:child_process"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { cpus, homedir, tmpdir } from "node:os"
import { basename, join } from "node:path"
import { promisify } from "node:util"
import type { RunChildSessionResult, SessionRunner } from "../runtime/types.js"
import { resolveAgentType } from "./agent-alias.js"
import {
  createJournalWriter,
  createReplayState,
  generateRunId,
  hashAgentCall,
  hashArgs,
  hashScript,
  loadJournal,
  type JournalWriter,
  type ReplayState,
} from "./journal.js"
import { parseWorkflowScript, type WorkflowMeta } from "./meta.js"
import { adoptFromSandbox, runInWorkflowSandbox, type WorkflowHostBridge } from "./sandbox.js"
import {
  buildSchemaInstruction,
  buildSchemaRetryPrompt,
  collectRefProblems,
  collectUnsupportedKeywords,
  parseWithSchema,
  validateValue,
  type JsonSchemaLike,
  type SchemaParseResult,
} from "./schema.js"

const execFileAsync = promisify(execFile)

/**
 * Sent as the `system` prompt of every agent() child session turn.
 *
 * Claude Code tells its subagents that their final text IS the return value, so
 * they emit raw data rather than a conversational reply. Without it a subagent
 * answers "Here's what I found: ..." and that prose becomes the script's value.
 * It goes in `system` rather than in the prompt so it never enters the resume
 * hash and never shows up in a test's prompt assertions.
 */
export const SUBAGENT_SYSTEM_PROMPT = [
  "You are running as a subagent inside a workflow script.",
  "Your final message is consumed programmatically as the return value of a function call - it is never shown to a human.",
  "Emit only the requested data: no preamble, no restatement of the task, no markdown headings, and no closing summary.",
].join(" ")

/**
 * Error shapes that are worth another attempt: rate limits, overload, gateway
 * and network faults. Anything else (auth, 4xx, an unknown agent, a model
 * refusal) is terminal and returns null immediately, because retrying it would
 * just burn tokens and wall clock.
 */
const TRANSIENT_ERROR_PATTERN =
  /rate.?limit|overload|too many requests|timed? ?out|temporarily|unavailable|bad gateway|connection|socket hang up|ECONNRESET|ETIMEDOUT|EAI_AGAIN|\b(429|500|502|503|504)\b/i

/**
 * Reasoning-effort levels, which map 1:1 onto OpenCode model variant ids: the
 * engine sends `variant: <effort>` on the child session's prompt and OpenCode
 * merges that model's `variants[<effort>]` into the provider options.
 */
export const AGENT_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const
export type AgentEffort = (typeof AGENT_EFFORTS)[number]

/** The only isolation mode OpenCode can provide; see AgentCallOptions.isolation. */
export const AGENT_ISOLATIONS = ["worktree"] as const
export type AgentIsolation = (typeof AGENT_ISOLATIONS)[number]

export interface AgentCallOptions {
  label?: string
  phase?: string
  schema?: JsonSchemaLike
  model?: string
  agentType?: string
  /** Reasoning effort, sent to OpenCode as this call's model variant. */
  effort?: AgentEffort
  /**
   * "worktree" runs the agent in a fresh git worktree of the workflow's
   * working directory so parallel file-mutating agents cannot conflict. It is
   * the only supported value: Claude Code's "remote" needs a cloud sandbox
   * OpenCode does not have, so it - and any typo - throws rather than silently
   * running the agent unisolated in the user's own working directory.
   */
  isolation?: AgentIsolation
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
  /** Fired once per spawned child session, as soon as its id is known. */
  onChildSession?: (child: WorkflowChildSession) => void
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
  /**
   * Hard output-token ceiling for budget.remaining(); null means unlimited.
   * Scoped to the child sessions this run spawns - see `budget` below.
   */
  budgetTokens?: number | null
  /**
   * Output tokens already spent in the ENCLOSING assistant turn, seeded into
   * shared.tokensSpent so budget.spent() reports Claude Code's per-turn pool
   * rather than this run in isolation. Top-level runs only; a workflow() child
   * inherits the parent's accumulator through sharedState.
   */
  budgetSpentSeed?: number
  maxAgents?: number
  maxItems?: number
  schemaRetries?: number
  /** Retries for a TRANSIENT child-session failure (rate limit, 5xx, network). */
  agentRetries?: number
  /** Base delay for the transient-failure backoff; doubles per attempt. */
  agentRetryBackoffMs?: number
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
  /**
   * Output tokens accumulated by live agent() child sessions in this run,
   * including nested workflow() children. Starts at 0 for every top-level run;
   * the parent session's own token use is deliberately excluded (see `budget`).
   */
  tokensSpent: number
  /**
   * agent() calls that have passed the budget gate but not yet reported their
   * spend. A child's cost is unknowable until it returns, so every in-flight
   * call counts as at least one token against the ceiling - otherwise a
   * fan-out no wider than the concurrency cap has every item read
   * tokensSpent === 0 in the same tick and the budget is bypassed entirely,
   * however small it is.
   */
  inFlight: number
  /** Journal for this run; agent() calls from nested workflow() children share it. */
  journal?: JournalWriter
  /** Replay cursor when resuming from a prior run's journal. */
  replay?: ReplayState
  /** First breached ceiling in this run, logged once and surfaced on the result. */
  limitBreach?: string
}

/** One agent() child session, for the tool's "which sessions did this spawn" report. */
export interface WorkflowChildSession {
  sessionID: string
  label: string
  phase?: string
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
  /** Same sessions as sessionIDs, with the label and phase each belongs to. */
  children: WorkflowChildSession[]
  /** First breached ceiling, if any; the agent() calls after it returned null. */
  limitBreach?: string
}

/**
 * Concurrent agent() calls are capped at min(16, cpu cores - 2), matching
 * Claude Code's workflow default. Excess calls queue on the semaphore and run
 * as slots free up, so a 100-item parallel()/pipeline() still completes.
 */
export const DEFAULT_CONCURRENCY = Math.min(16, Math.max(1, cpus().length - 2))
const DEFAULT_MAX_AGENTS = 1000
const DEFAULT_MAX_ITEMS = 4096
/**
 * Schema retries are the ONLY retry budget for structured output. OpenCode
 * accepts a `format.retryCount` and defaults it to 2, but references it
 * nowhere in 1.15: a miss is reported as a terminal StructuredOutputError with
 * `retries: 0` after exactly one model turn. So the engine never sends it and
 * re-prompts in the same child session instead, which also lets it feed the
 * concrete validation error back to the model - something a native retry could
 * not do, since OpenCode does not validate the tool arguments at all.
 */
const DEFAULT_SCHEMA_RETRIES = 2
const DEFAULT_AGENT_RETRIES = 2
const DEFAULT_AGENT_RETRY_BACKOFF_MS = 500

export async function runWorkflowScript(input: RunWorkflowScriptInput): Promise<WorkflowScriptResult> {
  const { meta, body } = parseWorkflowScript(input.script)
  const maxItems = input.maxItems ?? DEFAULT_MAX_ITEMS
  const schemaRetries = input.schemaRetries ?? DEFAULT_SCHEMA_RETRIES
  const agentRetries = input.agentRetries ?? DEFAULT_AGENT_RETRIES
  const retryBackoffMs = input.agentRetryBackoffMs ?? DEFAULT_AGENT_RETRY_BACKOFF_MS
  const depth = input.nestingDepth ?? 0
  // A nested workflow's agents belong to their own group in the progress tree;
  // without this a child's phase() silently rewrites the parent's roadmap.
  const events = depth > 0 ? groupEvents(input.events, meta.name) : input.events
  // A workflow() child borrows the parent's state so its agents queue on the
  // same semaphore and count against the same lifetime cap and token budget.
  const shared: WorkflowSharedState = input.sharedState ?? {
    semaphore: createSemaphore(Math.max(1, input.concurrency ?? DEFAULT_CONCURRENCY)),
    budgetTotal: input.budgetTokens ?? null,
    maxAgents: input.maxAgents ?? DEFAULT_MAX_AGENTS,
    agentCount: 0,
    tokensSpent: Math.max(0, input.budgetSpentSeed ?? 0),
    inFlight: 0,
  }

  // The run id is minted here, outside the script sandbox, so scripts stay
  // deterministic. Only the top-level run owns a journal; workflow() children
  // append to it through the shared state.
  const runId = input.runId ?? generateRunId()
  const argsHash = hashArgs(input.args)
  // log() is not defined until further down, so the resume note is deferred.
  let resumeNote: string | undefined
  if (!input.sharedState) {
    if (input.resumeFromRunId) {
      if (!input.workingDirectory) {
        throw new Error("resumeFromRunId requires a working directory to load the journal from.")
      }
      const journal = await loadJournal(input.workingDirectory, input.resumeFromRunId)
      // agent() hashes cover the prompt and options but never args. That is
      // sound rather than a hole: args can only reach a child session THROUGH
      // the prompt or the hashed options, so an arg change that matters shows
      // up as a hash miss, which switches the run permanently to live mode from
      // that call on; an arg change that alters no call leaves those calls
      // byte-identical, and replaying them is exactly what the prefix rule
      // promises. Claude Code keys the cache on script + args and treats a
      // mismatch as fewer cache hits, not a hard failure - so note it, run it.
      if (journal.header?.argsHash !== undefined && journal.header.argsHash !== argsHash) {
        resumeNote =
          `Resuming "${input.resumeFromRunId}" with different args: only agent() calls whose prompt and options are unchanged replay from cache, and the first changed call switches the rest of the run to live execution.`
      }
      shared.replay = createReplayState(journal.entries)
    }
    if (input.workingDirectory) {
      shared.journal = await createJournalWriter(input.workingDirectory, {
        runId,
        scriptHash: hashScript(input.script),
        argsHash,
        meta,
      })
    }
  }

  const logs: string[] = []
  const phases: string[] = []
  const sessionIDs: string[] = []
  const children: WorkflowChildSession[] = []
  /**
   * Child sessions with a turn in flight right now, so a run that ends early
   * can stop them server-side. Per-run rather than shared: a nested workflow()
   * run owns its own children and runs its own teardown.
   */
  const liveSessions = new Set<string>()
  // Internal controller so a script failure also cancels in-flight agents;
  // it mirrors the caller's signal when one is provided.
  const controller = new AbortController()
  if (input.abort?.aborted) controller.abort()
  input.abort?.addEventListener("abort", () => controller.abort(), { once: true })
  const signal = controller.signal
  let currentPhase: string | undefined

  /**
   * Token accounting matches Claude Code's per-TURN pool as closely as this
   * host allows. spent() sums the `output` tokens of every live agent() child
   * session in this run and its nested workflow() children, seeded with
   * budgetSpentSeed - the tokens already spent this turn by earlier workflow
   * tool calls (exact) plus whatever the parent assistant message has committed
   * so far (a lower bound: OpenCode commits usage at step boundaries and the
   * step holding this tool call has not finished, so it often reads 0).
   *
   * Still excluded: `reasoning` tokens, which OpenCode reports separately from
   * `output`, and agent() results replayed from a journal (no session, no
   * spend). Resume is unaffected by the seed: shared.replay.take(hash) is
   * consulted before the semaphore and the budget check, so a replayed prefix
   * never reads the budget and a seeded spend cannot make a replay throw.
   */
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
    events?.onPhase?.(title)
  }

  const log = (message: string): void => {
    const text = String(message)
    logs.push(text)
    events?.onLog?.(text)
  }

  if (resumeNote) log(resumeNote)

  /**
   * A breached ceiling makes every later agent() throw, and inside
   * parallel()/pipeline() those throws become nulls. Record and log the first
   * one so a fan-out that comes back full of holes still says why - the log
   * line and the result field are out-of-band, so script-visible control flow
   * stays exactly what Claude Code's contract specifies.
   */
  const reportLimit = (text: string): void => {
    if (shared.limitBreach) return
    shared.limitBreach = text
    log(text)
  }

  /**
   * Agent names this OpenCode instance knows, fetched at most once per run and
   * only when some agent() call actually passes an agentType.
   */
  let agentRegistry: Promise<string[] | undefined> | undefined
  /** Claude Code names already reported, so a 100-agent fan-out logs the rewrite once. */
  const aliasLogged = new Set<string>()

  /**
   * agent() returns null when the subagent fails terminally (after transient
   * retries) or when its output never satisfies the schema.
   *
   * GAP vs. Claude Code, which also returns null "if the user skips the agent
   * mid-run" and keeps the script going. OpenCode exposes no per-agent skip:
   * the only cancellation signal reaching a tool call is `context.abort`, which
   * covers the whole run, and there is no UI affordance to cancel one child
   * session. So there is nothing that could produce the skip-null, and an abort
   * stays fatal rather than being silently degraded to nulls - a cancelled run
   * must not look like a run that completed with holes in it. A ported script
   * that filters with .filter(Boolean) still behaves correctly; it just never
   * sees a null from this cause.
   */
  const agent = async (prompt: string, opts: AgentCallOptions = {}): Promise<unknown> => {
    if (typeof prompt !== "string" || prompt.trim() === "") {
      throw new WorkflowUsageError("agent() requires a non-empty prompt string.")
    }
    // Options are validated before the seq is assigned, so a rejected call does
    // not burn a lifetime-cap slot or shift resume-replay seq numbering, and
    // outside the try/catch below, which turns errors into a null agent result.
    const effort = requireOneOf(
      "effort",
      opts.effort,
      AGENT_EFFORTS,
      "It selects the model's reasoning variant; drop the option to use the model's default.",
    )
    requireOneOf(
      "isolation",
      opts.isolation,
      AGENT_ISOLATIONS,
      'OpenCode has no remote sandbox, so isolation: "remote" cannot be honored - use "worktree" for local git-worktree isolation, or drop the option.',
    )
    if (opts.schema !== undefined) {
      const unsupported = collectUnsupportedKeywords(opts.schema)
      if (unsupported.length > 0) {
        throw new WorkflowUsageError(
          `agent(): schema uses JSON Schema keywords this validator cannot evaluate: ${unsupported.join(", ")}. ` +
            "They would be silently ignored, so the result would be under-validated. Use the supported keyword set instead.",
        )
      }
      // Checked here rather than at validation time so an unfollowable ref
      // fails the call outright instead of reading as a schema miss, which
      // would burn every schema retry before returning null.
      const refProblems = collectRefProblems(opts.schema)
      if (refProblems.length > 0) {
        throw new WorkflowUsageError(
          `agent(): schema has $ref(s) this validator cannot follow: ${refProblems.join("; ")}. ` +
            'Only internal JSON-pointer refs into the same schema are supported (e.g. "#/$defs/Node", "#").',
        )
      }
    }
    // Resolved once here and reused by runSession below. An unknown agent
    // otherwise fails server-side and arrives back as a null agent result -
    // indistinguishable from a flaky subagent, and just a null item inside
    // parallel(). resolveAgentType also rewrites Claude Code's agent names
    // ("general-purpose", "Explore", ...) onto their OpenCode equivalents so a
    // ported Workflow script resolves; see agent-alias.ts.
    let resolvedAgentType: string | undefined
    if (opts.agentType !== undefined) {
      agentRegistry ??= input.runner.listAgents?.() ?? Promise.resolve(undefined)
      const resolution = resolveAgentType(opts.agentType, await agentRegistry)
      if (!resolution.ok) throw new WorkflowUsageError(resolution.message)
      resolvedAgentType = resolution.agent
      if (resolution.aliasedFrom !== undefined && !aliasLogged.has(resolution.aliasedFrom)) {
        aliasLogged.add(resolution.aliasedFrom)
        log(
          `agent(): agentType "${resolution.aliasedFrom}" is a Claude Code name; using OpenCode agent "${resolution.agent}".`,
        )
      }
    }
    // seq is recorded for ordering and debugging only; resume replay matches on
    // the call hash (see createReplayState). Cached replays still count toward
    // the lifetime cap even though they never spawn a session.
    shared.agentCount += 1
    const seq = shared.agentCount
    // onAgentStart/onAgentEnd deliberately do not fire for a limit-rejected
    // call: a 500-item fan-out past the ceiling would otherwise flood the
    // progress roadmap with failed agents that never ran.
    if (seq > shared.maxAgents) {
      const text = `Workflow exceeded the ${shared.maxAgents}-agent lifetime cap; later agent() calls return null.`
      reportLimit(text)
      throw new WorkflowLimitError(text)
    }
    const label = opts.label ?? truncate(prompt.replace(/\s+/g, " ").trim(), 50)
    const agentPhase = opts.phase ?? currentPhase
    // A script that declares meta.phases and passes `phase:` per agent - the
    // documented pipeline pattern - never calls phase(), so without this the
    // roadmap and the result's phase list stay empty for the whole run.
    if (agentPhase !== undefined && !phases.includes(agentPhase)) {
      phases.push(agentPhase)
      events?.onPhase?.(agentPhase)
    }
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
    const cached = shared.replay?.take(hash)
    if (cached) {
      // Journaled replay: no session spawned, no token spend; events still
      // fire, and the entry is re-journaled so this run is itself resumable.
      events?.onAgentStart?.(event)
      events?.onAgentEnd?.({ ...event, ok: cached.result !== null })
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
    // Each in-flight call is charged a floor of one token: its real cost is not
    // known until it returns, and without this a concurrent fan-out passes the
    // gate en masse before any spend is credited.
    if (shared.budgetTotal !== null && shared.tokensSpent + shared.inFlight >= shared.budgetTotal) {
      release()
      const text = `Token budget exhausted: spent ${shared.tokensSpent} of ${shared.budgetTotal} output tokens; later agent() calls return null.`
      reportLimit(text)
      throw new WorkflowLimitError(text)
    }
    shared.inFlight += 1

    const runSession = async (directory?: string): Promise<unknown> => {
      // Resolved here rather than at validation time so a journal-replayed
      // call, which returns above, never pays for the catalogue lookup.
      const variant = effort
        ? await resolveVariant(effort, agentModel, input.runner, label, log)
        : undefined
      const agentType = resolvedAgentType ?? input.defaultAgent
      const session = await input.runner.createChildSession({
        title: label,
        agent: agentType,
        model: agentModel,
        directory,
        phase: agentPhase,
      })
      sessionIDs.push(session.sessionID)
      const child: WorkflowChildSession = { sessionID: session.sessionID, label, phase: agentPhase }
      children.push(child)
      events?.onChildSession?.(child)

      // OpenCode's native structured output forces a StructuredOutput tool
      // call, which some providers reject outright (extended-thinking models
      // answer `tool_choice: "required"` with a 400 and no output at all).
      // This flips off for the rest of the session when that happens, leaving
      // the prompt instruction below to carry the call.
      let nativeSchema = opts.schema !== undefined

      const send = async (text: string): Promise<RunChildSessionResult> => {
        let attempt = 0
        for (;;) {
          // Live for the duration of the call, and deliberately left live if it
          // REJECTS: a cancelled prompt only tears down the local request, so a
          // call that never returned is exactly the one whose turn may still be
          // running on the server.
          liveSessions.add(session.sessionID)
          const result = await input.runner.runChildSession({
            sessionID: session.sessionID,
            agent: agentType,
            model: agentModel,
            prompt: text,
            system: SUBAGENT_SYSTEM_PROMPT,
            abort: signal,
            directory,
            variant,
            ...(nativeSchema && opts.schema ? { schema: opts.schema } : {}),
          })
          liveSessions.delete(session.sessionID)
          shared.tokensSpent += result.tokens?.output ?? 0
          if (!result.error) return result
          const transient = TRANSIENT_ERROR_PATTERN.test(result.error)
          if (nativeSchema && result.errorName === "APIError" && !transient) {
            nativeSchema = false
            log(
              `agent "${label}": provider rejected native structured output (${result.error}); retrying with the prompt instruction instead.`,
            )
            continue
          }
          // Claude Code returns null only after retries; a rate limit or a
          // gateway blip must not read the same as a real failure.
          if (attempt >= agentRetries || !transient) return result
          attempt += 1
          await sleep(retryBackoffMs * 2 ** (attempt - 1), signal)
          if (signal.aborted) throw new WorkflowAbortError()
        }
      }

      // The prompt instruction stays even when the schema is sent natively: it
      // is the only thing that recovers the call on an OpenCode too old to know
      // `format` (unknown body fields are dropped, not rejected) and on a
      // provider that refuses the forced tool call - in both the model still
      // answers in prose.
      const fullPrompt = opts.schema ? prompt + buildSchemaInstruction(opts.schema) : prompt
      /**
       * A model that answers in prose instead of calling the forced
       * StructuredOutput tool makes OpenCode report a StructuredOutputError -
       * while still returning that prose. That is a schema miss, not a failed
       * call: treating it as terminal threw away both the answer text (which
       * the prompt instruction usually made valid JSON) and every schema retry.
       */
      const schemaMiss = (value: RunChildSessionResult): boolean =>
        opts.schema !== undefined && value.errorName === "StructuredOutputError"
      let result = await send(fullPrompt)
      if (result.error && !schemaMiss(result)) {
        events?.onAgentEnd?.({ ...event, ok: false })
        return null
      }
      if (!opts.schema) {
        events?.onAgentEnd?.({ ...event, ok: true })
        return result.text
      }
      const schema = opts.schema
      /**
       * Prefer the natively captured value, fall back to scraping the text.
       * Both go through the local validator: OpenCode attaches no validator to
       * the StructuredOutput tool's input schema, so `structured` is whatever
       * the model passed - a wrong type or an extra property under
       * `additionalProperties: false` both arrive marked valid.
       */
      const resolve = (value: RunChildSessionResult): SchemaParseResult =>
        value.structured !== undefined
          ? validateValue(value.structured, schema)
          : parseWithSchema(value.text, schema)
      let parsed = resolve(result)
      let attempts = 0
      while (!parsed.ok && attempts < schemaRetries) {
        attempts += 1
        result = await send(buildSchemaRetryPrompt(parsed.error ?? "invalid JSON", schema))
        if (result.error && !schemaMiss(result)) break
        parsed = resolve(result)
      }
      events?.onAgentEnd?.({ ...event, ok: parsed.ok })
      if (!parsed.ok) {
        // NOT a deviation from Claude Code: its tool-layer retry bottoms out
        // the same way - a subagent that never produces a valid structured
        // call yields null - but its retry budget is the subagent's own turn
        // limit rather than a fixed count, so say how many attempts this one
        // got and why they failed.
        log(
          `agent "${label}": output never satisfied the schema after ${attempts} of ${schemaRetries} re-prompts (${parsed.error ?? "invalid JSON"}); returning null.`,
        )
      }
      return parsed.ok ? parsed.value : null
    }

    events?.onAgentStart?.(event)
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
        if (removed) {
          // Cleared so the catch below does not try to remove it a second time.
          worktree = undefined
        } else {
          log(`agent "${label}" left changes in worktree ${worktree}; harvest them from that path.`)
          if (typeof value === "string") {
            value = `${value}\n\n[worktree with changes preserved at: ${worktree}]`
          }
        }
      }
      journalResult(value)
      // The child call can resolve normally when the cancellation lands after
      // its response, so without this a run cancelled mid-agent would report
      // success. The result is journaled first: the work really happened, so a
      // resume should not pay for it twice.
      if (signal.aborted) throw new WorkflowAbortError()
      return value
    } catch (error) {
      if (worktree && root) {
        const removed = await removeWorktreeIfClean(root, worktree)
        if (!removed) {
          log(`agent "${label}" failed but left changes in worktree ${worktree}; harvest them from that path.`)
        }
      }
      events?.onAgentEnd?.({ ...event, ok: false })
      if (signal.aborted) {
        throw error instanceof WorkflowAbortError ? error : new WorkflowAbortError()
      }
      journalResult(null)
      return null
    } finally {
      shared.inFlight -= 1
      release()
    }
  }

  // parallel() and pipeline() live in the sandbox realm (see sandbox.ts): they
  // are pure orchestration over script-land thunks, and running them host-side
  // would mean handing script functions a host Promise to attach to.

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
      agentRetries: input.agentRetries,
      agentRetryBackoffMs: input.agentRetryBackoffMs,
      events,
      sharedState: shared,
      nestingDepth: depth + 1,
    })
    sessionIDs.push(...child.sessionIDs)
    children.push(...child.children)
    return child.value
  }

  const bridge: WorkflowHostBridge = {
    maxItems,
    // Structured values reach the script as JSON, so args must be
    // JSON-serializable; in production it always is (the tool's JSON input).
    argsJSON: input.args === undefined ? undefined : JSON.stringify(input.args),
    aborted: () => signal.aborted,
    budgetJSON: () =>
      JSON.stringify({
        total: budget.total,
        spent: budget.spent(),
        // JSON cannot carry Infinity; null means "no ceiling".
        remaining: budget.total === null ? null : budget.remaining(),
      }),
    log,
    phase: (title) => {
      if (title !== null) phase(title)
    },
    // Resolves rather than rejects so a host Error object never lands in a
    // script's catch block, where its constructor chain would leak the realm.
    callAsync: async (name, callArgsJSON) => {
      try {
        const callArgs = JSON.parse(callArgsJSON) as unknown[]
        const result =
          name === "agent"
            ? await agent(callArgs[0] as string, (callArgs[1] ?? {}) as AgentCallOptions)
            : await workflow(callArgs[0], callArgs[1])
        return JSON.stringify({ ok: true, value: result })
      } catch (error) {
        return JSON.stringify({
          ok: false,
          error: {
            message: message(error),
            abort: causedBy(error, WorkflowAbortError, "workflowAbort") || signal.aborted,
            usage: causedBy(error, WorkflowUsageError, "workflowUsage"),
            limit: causedBy(error, WorkflowLimitError, "workflowLimit"),
          },
        })
      }
    },
  }

  let value: unknown
  try {
    value = adoptFromSandbox(await runInWorkflowSandbox(body, bridge))
  } catch (error) {
    // Cancel any agents the script left in flight so they stop consuming
    // sessions and tokens after the failure is reported.
    //
    // Aborting the signal is NOT enough on its own: it only cancels the local
    // HTTP request. Verified live against opencode 1.15.10 - a child whose
    // prompt fetch was aborted 20s early still finished its turn and committed
    // the tokens - so the child session has to be stopped server-side too.
    const stranded = [...liveSessions]
    controller.abort()
    await Promise.all(stranded.map((sessionID) => input.runner.abortSession?.(sessionID)))
    await shared.journal?.flush()
    throw new WorkflowScriptError(
      message(error),
      {
        meta,
        runId,
        value: undefined,
        logs,
        phases,
        agentCount: shared.agentCount,
        tokensSpent: shared.tokensSpent,
        sessionIDs,
        children,
        limitBreach: shared.limitBreach,
      },
      error,
    )
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
    children,
    limitBreach: shared.limitBreach,
  }
}

/** Thrown by agent() when the workflow is cancelled; never converted to null. */
export class WorkflowAbortError extends Error {
  constructor() {
    super("Workflow aborted.")
    this.name = "WorkflowAbortError"
  }
}

/**
 * Thrown when a run limit is breached: the agent lifetime cap or the token
 * budget ceiling. It reaches script code as a throw from agent(), exactly as
 * Claude Code's budget ceiling does ("once spent() reaches total, further
 * agent() calls throw"), which means parallel()/pipeline() degrade it to a null
 * item like any other thunk failure. The breach is logged once and reported on
 * the run result (WorkflowScriptResult.limitBreach) so a fan-out full of nulls
 * is still explained.
 */
export class WorkflowLimitError extends Error {
  constructor(msg: string) {
    super(msg)
    this.name = "WorkflowLimitError"
  }
}

/**
 * Thrown for a mistake in the workflow script itself - an agent() option
 * OpenCode cannot honor, an unsupported schema keyword, an empty prompt.
 *
 * Unlike a limit breach this is NOT degraded to null by parallel()/pipeline():
 * these are options Claude Code ACCEPTS and returns real results for, so a null
 * here would be a silent wrong answer rather than a matching one - and the
 * failure is total, so the whole fan-out would come back null with no reason
 * given.
 */
export class WorkflowUsageError extends Error {
  constructor(msg: string) {
    super(msg)
    this.name = "WorkflowUsageError"
  }
}

export class WorkflowScriptError extends Error {
  readonly partial: WorkflowScriptResult

  constructor(msg: string, partial: WorkflowScriptResult, cause?: unknown) {
    super(msg, cause === undefined ? undefined : { cause })
    this.name = "WorkflowScriptError"
    this.partial = partial
  }
}

/**
 * Whether `error` is of the given class, carries the sandbox's equivalent flag,
 * or wraps either as its cause.
 *
 * All three forms are needed because one failure changes shape as it crosses
 * boundaries: agent() throws the host class, the sandbox re-throws it as a
 * realm-local Error carrying `flag` (classes cannot cross realms), and a nested
 * workflow() wraps that in a WorkflowScriptError. Miss a form and a child's
 * abort or usage error degrades to a null item in the parent's
 * parallel()/pipeline() instead of failing the run.
 */
function causedBy(
  error: unknown,
  type: new (...args: never[]) => Error,
  flag: "workflowAbort" | "workflowUsage" | "workflowLimit",
): boolean {
  if (error instanceof type) return true
  if (typeof error !== "object" || error === null) return false
  if ((error as Record<string, unknown>)[flag] === true) return true
  return error instanceof WorkflowScriptError && causedBy(error.cause, type, flag)
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
 * Read a workflow script given either a path (absolute or containing a
 * separator) or a bare saved-workflow name. Shared by the tool's `scriptPath`
 * input and workflow()'s `{ scriptPath }` form so both resolve identically.
 */
export async function loadWorkflowScriptFile(
  pathOrName: string,
  workingDirectory: string | undefined,
): Promise<string> {
  const looksLikePath = pathOrName.includes("/") || pathOrName.includes("\\") || pathOrName.endsWith(".js")
  return loadChildWorkflowScript(looksLikePath ? { scriptPath: pathOrName } : pathOrName, workingDirectory)
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
    const available = await listSavedWorkflows(workingDirectory)
    const suffix = available.length === 0
      ? ""
      : ` Available: ${available.map(describeSavedWorkflow).join("; ")}.`
    throw new Error(`Unknown workflow "${name}". Looked for ${candidates.join(", ")}.${suffix}`)
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

export interface SavedWorkflow {
  name: string
  description: string
  whenToUse?: string
  scriptPath: string
}

/**
 * Every saved workflow under `<workingDirectory>/.opencode/workflows` and
 * `~/.config/opencode/workflows`, with its parsed meta. This is what makes
 * `meta.whenToUse` load-bearing rather than a field the parser validates and
 * nobody reads: it is shown when workflow() is handed an unknown name, and the
 * workflow tool reports it so the model can pick an existing workflow.
 * Unparseable and unreadable files are skipped.
 */
export async function listSavedWorkflows(workingDirectory?: string): Promise<SavedWorkflow[]> {
  const directories: string[] = []
  if (workingDirectory) directories.push(join(workingDirectory, ".opencode", "workflows"))
  directories.push(join(homedir(), ".config", "opencode", "workflows"))
  const found = new Map<string, SavedWorkflow>()
  for (const directory of directories) {
    let files: string[]
    try {
      files = await readdir(directory)
    } catch {
      continue
    }
    for (const file of files.sort()) {
      if (!file.endsWith(".js")) continue
      const scriptPath = join(directory, file)
      const script = await readScriptFile(scriptPath)
      if (script === undefined) continue
      let meta: WorkflowMeta
      try {
        meta = parseWorkflowScript(script).meta
      } catch {
        continue
      }
      const key = basename(file, ".js")
      // The project directory is searched first and wins, matching resolution.
      if (!found.has(key)) {
        found.set(key, {
          name: meta.name,
          description: meta.description,
          whenToUse: meta.whenToUse,
          scriptPath,
        })
      }
    }
  }
  return [...found.values()]
}

function describeSavedWorkflow(entry: SavedWorkflow): string {
  return `"${entry.name}" (${entry.whenToUse ?? entry.description})`
}

/** Abort-aware sleep used by the transient-failure backoff. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const timer = setTimeout(finish, ms)
    function finish(): void {
      clearTimeout(timer)
      signal.removeEventListener("abort", finish)
      resolve()
    }
    signal.addEventListener("abort", finish, { once: true })
  })
}

/**
 * Wrap a nested workflow's events so its agents render under a "> name" group
 * instead of merging into the parent's flat phase tree, where a child phase()
 * would rewrite the parent's roadmap.
 */
function groupEvents(
  events: WorkflowScriptEvents | undefined,
  name: string,
): WorkflowScriptEvents | undefined {
  if (!events) return undefined
  const group = `> ${name}`
  const scope = (phase: string | undefined): string => (phase ? `${group} · ${phase}` : group)
  return {
    onPhase: events.onPhase && ((title) => events.onPhase?.(scope(title))),
    onLog: events.onLog && ((entry) => events.onLog?.(`${group}: ${entry}`)),
    onAgentStart: events.onAgentStart && ((event) => events.onAgentStart?.({ ...event, phase: scope(event.phase) })),
    onAgentEnd: events.onAgentEnd && ((event) => events.onAgentEnd?.({ ...event, phase: scope(event.phase) })),
    onChildSession: events.onChildSession && ((child) => events.onChildSession?.({ ...child, phase: scope(child.phase) })),
  }
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

/**
 * Reject an agent() option value OpenCode cannot honor, returning it narrowed
 * when it is legal. Throwing beats ignoring: a silently dropped option means a
 * script author who asked for isolation or extra reasoning gets neither and is
 * never told.
 */
function requireOneOf<T extends string>(
  option: string,
  value: unknown,
  allowed: readonly T[],
  hint: string,
): T | undefined {
  if (value === undefined) return undefined
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) {
    return value as T
  }
  const supported = allowed.map((entry) => `"${entry}"`).join(", ")
  throw new WorkflowUsageError(
    `agent(): unsupported ${option} ${JSON.stringify(value)}. Supported values: ${supported}. ${hint}`,
  )
}

/**
 * Reasoning variants ordered from least to most effort, spanning the ids
 * OpenCode's providers actually emit. Used only to pick the nearest available
 * variant when a model does not expose the requested one.
 */
const EFFORT_RANK = ["none", "minimal", "low", "medium", "high", "xhigh", "max"]

/**
 * Map an effort onto a variant the target model actually exposes. OpenCode
 * silently ignores a variant a model does not define, so an unavailable effort
 * is downgraded to the nearest one and logged rather than quietly doing
 * nothing. Most Anthropic models expose only "high" and "max", so downgrades
 * are common enough that the log line matters.
 */
async function resolveVariant(
  effort: AgentEffort,
  model: string | undefined,
  runner: SessionRunner,
  label: string,
  log: (message: string) => void,
): Promise<string | undefined> {
  if (!model || !runner.listModelVariants) return effort
  const available = await runner.listModelVariants(model)
  // An unreadable catalogue is not a reason to fail or to second-guess the
  // script: send the requested variant and let the server decide.
  if (available === undefined) return effort
  if (available.includes(effort)) return effort
  const want = EFFORT_RANK.indexOf(effort)
  const nearest = available
    .filter((id) => EFFORT_RANK.includes(id))
    .sort((a, b) => {
      const distance = Math.abs(EFFORT_RANK.indexOf(a) - want) - Math.abs(EFFORT_RANK.indexOf(b) - want)
      // Ties break upward, so a request lands on more reasoning, not less.
      return distance !== 0 ? distance : EFFORT_RANK.indexOf(b) - EFFORT_RANK.indexOf(a)
    })[0]
  if (!nearest) {
    log(`agent "${label}": model ${model} exposes no reasoning variants; effort "${effort}" ignored.`)
    return undefined
  }
  log(`agent "${label}": model ${model} has no "${effort}" variant; using "${nearest}".`)
  return nearest
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value
  return value.slice(0, max - 1) + "…"
}

function message(error: unknown): string {
  if (error instanceof Error) return error.message
  // Errors thrown inside the sandbox realm are Errors of that realm, so they
  // fail the host's instanceof check; read their message structurally.
  if (typeof error === "object" && error !== null) {
    const text = (error as { message?: unknown }).message
    if (typeof text === "string") return text
  }
  return String(error)
}

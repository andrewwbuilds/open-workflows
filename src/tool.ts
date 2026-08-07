import { tool } from "@opencode-ai/plugin"
import { z } from "zod"
import { resolveOptions } from "./options.js"
import { runWorkflow } from "./orchestrator.js"
import { formatError, formatWorkflowResult } from "./format.js"
import type { DynamicWorkflowOptions, ResolvedWorkflowOptions } from "./types.js"
import { createSdkRunner, type OpencodeClientLike } from "./runtime/sdk.js"
import type { SessionRunner } from "./runtime/types.js"
import { WorkflowProgress } from "./progress.js"
import { parseWorkflowScript } from "./script/meta.js"
import {
  loadWorkflowScriptFile,
  runWorkflowScript,
  WorkflowScriptError,
  type WorkflowScriptResult,
} from "./script/engine.js"
import { generateRunId } from "./script/journal.js"

export interface CreateToolInput {
  client: OpencodeClientLike
  pluginOptions: DynamicWorkflowOptions
}

const dynamicWorkflowInputShape = {
  goal: z.string().min(1).describe("The objective the workflow should accomplish."),
  mode: z.enum(["research", "implement", "review"]).optional()
    .describe("Workflow mode. 'research' for investigation, 'implement' for code changes, 'review' for verification."),
  allowEdits: z.boolean().optional()
    .describe("Allow workers to edit the worktree. Set true for implementation work. Defaults to false."),
  maxRounds: z.number().int().min(1).max(10).optional()
    .describe("Maximum planner-reviewer loop count. Defaults to 3."),
  maxWorkers: z.number().int().min(1).max(8).optional()
    .describe("Maximum workers per round (split between research and edit tasks). Defaults to 3."),
  maxTasks: z.number().int().min(1).max(50).optional()
    .describe("Maximum tasks accepted from the planner each round. Defaults to 20."),
  parallelWorkers: z.boolean().optional()
    .describe("Run read-only workers concurrently. Editing workers are always serial. Defaults to true."),
  successCriteria: z.array(z.string()).optional()
    .describe("Optional explicit criteria the reviewer checks against. The workflow stops when every criterion is met."),
  plannerAgent: z.string().optional()
    .describe("OpenCode agent name used for planning. Defaults to 'plan' or your plugin config."),
  workerAgent: z.string().optional()
    .describe("Default OpenCode agent name for workers. Defaults to 'general' or your plugin config."),
  reviewerAgent: z.string().optional()
    .describe("OpenCode agent name used for review. Defaults to 'general' or your plugin config."),
  model: z.string().optional()
    .describe("Optional 'provider/model-id' override for all child sessions (e.g. 'anthropic/claude-haiku-4-5')."),
}

const TOOL_DESCRIPTION = [
  "Run a coordinated OpenCode workflow (planner -> workers -> reviewer loop) for a goal.",
  "Use this when the user asks for an audit, investigation, implementation plan, multi-step code change,",
  "or any task that benefits from decomposition, parallel exploration, and a reviewer pass before completion.",
  "Spawns child OpenCode sessions for each agent. Returns a formatted summary with session IDs you can navigate to.",
  "Editing is disabled by default; pass allowEdits=true to let workers modify files.",
].join(" ")

export function createDynamicWorkflowTool(input: CreateToolInput) {
  const defaults = resolveOptions(toResolvedDefaults(input.pluginOptions))

  return tool({
    description: TOOL_DESCRIPTION,
    args: dynamicWorkflowInputShape,
    async execute(args, context) {
      const criteria = (args.successCriteria && args.successCriteria.length > 0)
        ? args.successCriteria
        : defaults.successCriteria
      const parent = context.sessionID
      const runner = createSdkRunner(input.client, parent, { directory: context.directory })
      const options = resolveOptions({
        mode: args.mode ?? defaults.mode,
        allowEdits: args.allowEdits ?? defaults.allowEdits,
        maxRounds: args.maxRounds ?? defaults.maxRounds,
        maxWorkers: args.maxWorkers ?? defaults.maxWorkers,
        maxTasks: args.maxTasks ?? defaults.maxTasks,
        parallelWorkers: args.parallelWorkers ?? defaults.parallelWorkers,
        plannerAgent: args.plannerAgent ?? defaults.plannerAgent,
        workerAgent: args.workerAgent ?? defaults.workerAgent,
        reviewerAgent: args.reviewerAgent ?? defaults.reviewerAgent,
        model: args.model ?? defaults.model ?? (await runner.resolveParentModel?.()),
        successCriteria: criteria,
      })
      context.metadata({
        title: `Workflow: ${truncate(args.goal, 60)}`,
        metadata: {
          mode: options.mode,
          allowEdits: options.allowEdits,
          maxRounds: options.maxRounds,
          maxWorkers: options.maxWorkers,
          parentSessionID: parent,
        },
      })
      const progress = new WorkflowProgress({
        name: truncate(args.goal, 40),
        plannedPhases: ["Plan", "Work", "Review"],
        sink: (update) => context.metadata(update),
      })
      try {
        const result = await runWorkflow({
          goal: args.goal,
          parentSessionID: parent,
          runner: instrumentRunner(runner, progress),
          abort: context.abort,
          options,
          successCriteria: criteria,
          onRound: (round) => {
            progress.log(`round ${round.round}: ${round.review?.status ?? "no review"} - ${round.review?.summary ?? ""}`)
          },
        })
        progress.finish(result.status)
        return formatWorkflowResult(result)
      } catch (error) {
        progress.finish("failed")
        return formatError("dynamic_workflow failed", error, { goal: args.goal, mode: options.mode })
      }
    },
  })
}

const WORKFLOW_SCRIPT_DESCRIPTION = [
  "Execute a workflow script that orchestrates multiple subagents deterministically (Claude Code Workflow-compatible).",
  "The script is plain JavaScript (no TypeScript) and must begin with `export const meta = { name, description, phases }` as a pure literal.",
  "Available in the script body (async context, use await directly):",
  "agent(prompt, opts?) -> Promise<string|object|null>: spawn a subagent as an OpenCode child session; opts {label, phase, schema, model, agentType, effort, isolation}. With schema (JSON Schema) the schema is enforced natively where the provider supports it, then validated here and re-prompted on mismatch; returns null once retries are exhausted or the agent fails terminally.",
  "schema supports type/properties/required/additionalProperties/patternProperties/propertyNames/min-maxProperties/dependentRequired/dependentSchemas/items/prefixItems/contains/min-maxItems/uniqueItems/enum/const/oneOf/anyOf/allOf/not/if-then-else/pattern/min-maxLength/minimum/maximum/exclusive*/multipleOf. $ref, $defs and unevaluated* are REJECTED rather than ignored - inline the definitions instead.",
  "effort: 'low'|'medium'|'high'|'xhigh'|'max' sets the model variant (the reasoning budget) for that call; if the model does not expose the requested variant it is downgraded to the nearest one and logged. Any other value fails the workflow.",
  "isolation: 'worktree' is the ONLY supported value - it runs the agent in a fresh git worktree so parallel file-mutating agents cannot conflict; an unchanged worktree is removed afterwards, a dirty one is kept and its path is logged and appended to the agent's text result. Any other value (including Claude Code's 'remote', which needs a cloud sandbox OpenCode does not have) fails the workflow immediately rather than silently running without isolation.",
  "parallel(thunks) -> Promise<any[]>: run zero-arg async functions concurrently (barrier); a thunk that throws resolves to null - filter with .filter(Boolean). EXCEPTIONS that fail the whole run instead of degrading to null: cancellation, an unsupported agent() option, and a breached agent cap or token budget.",
  "pipeline(items, ...stages) -> Promise<any[]>: run each item through all stages independently with NO barrier between stages; each stage receives (prevResult, originalItem, index); a throwing stage drops the item to null and skips its remaining stages, with the same exceptions as parallel(). DEFAULT to pipeline for multi-stage work.",
  "phase(title): group subsequent agent() calls under this roadmap phase. log(message): emit a progress line. args: the value passed as this tool's `args` input. budget: {total, spent(), remaining()} in output tokens against `budgetTokens`; spent() counts ONLY the output tokens of child sessions this workflow (and its nested workflow() children) spawned, starts at 0 each run, and does not include this session's own token use.",
  "workflow(nameOrRef, args?) -> Promise<any>: run another workflow inline and return its script's return value; pass a saved workflow name (resolved from <workingDirectory>/.opencode/workflows/<name>.js then ~/.config/opencode/workflows/<name>.js) or {scriptPath: '/abs/path.js'}. The child shares this workflow's concurrency, token budget, and agent caps; nesting is one level only.",
  "Use the SAME phase titles in meta.phases as in phase() calls. The roadmap renders live in the TUI while the workflow runs.",
  "Concurrency is capped per workflow; excess agent() calls queue. Lifetime cap 1000 agents, 4096 items per parallel/pipeline call.",
  "The script runs in an isolated realm: no process, require, dynamic import(), fetch, timers, or Buffer - only the globals listed above plus standard JavaScript built-ins. Do filesystem and network work by asking an agent() to do it.",
  "Date.now(), argless new Date(), and Math.random() throw so runs stay deterministic and resumable - pass timestamps and seeds in via args instead. The console global is routed into log().",
  "Use this for multi-step orchestration where control flow should be deterministic (loops, conditionals, fan-out) rather than model-driven.",
  "Every run journals its agent() results under <workingDirectory>/.opencode/workflow-runs/<runId>.jsonl and reports its Run ID.",
  "Pass resumeFromRunId to resume: agent() calls matching the prior run's unchanged prefix replay instantly from the journal (no session, no token spend); the first changed call switches the rest of the run to live execution. Resuming with different `args` is refused, since the journaled results were computed for the old ones.",
  "Pass scriptPath instead of script to run a saved workflow file (a bare name resolves under .opencode/workflows then ~/.config/opencode/workflows); exactly one of script/scriptPath is required.",
].join(" ")

const workflowScriptInputShape = {
  script: z.string().min(1).optional()
    .describe("Self-contained workflow script starting with `export const meta = {...}` followed by the body using agent()/parallel()/pipeline()/phase()/log(). Omit when passing scriptPath."),
  scriptPath: z.string().min(1).optional()
    .describe("Path to a saved workflow script, or a bare saved-workflow name resolved from <workingDirectory>/.opencode/workflows/<name>.js then ~/.config/opencode/workflows/<name>.js. Mutually exclusive with script."),
  args: z.unknown().optional()
    .describe("Optional input exposed to the script as the global `args`, verbatim. Pass arrays/objects as JSON values, not stringified."),
  budgetTokens: z.number().int().min(1).optional()
    .describe("Optional hard output-token ceiling for the run; exposed to the script as budget.total."),
  agent: z.string().optional()
    .describe("Default OpenCode agent for agent() calls (opts.agentType overrides per call). Defaults to 'general' or your plugin config."),
  model: z.string().optional()
    .describe("Optional 'provider/model-id' override for all child sessions."),
  resumeFromRunId: z.string().optional()
    .describe("Run ID of a prior run (e.g. 'wf_1a2b...') to resume: unchanged agent() calls replay from that run's journal instead of spawning sessions."),
}

export function createWorkflowScriptTool(input: CreateToolInput) {
  const defaults = input.pluginOptions
  return tool({
    description: WORKFLOW_SCRIPT_DESCRIPTION,
    args: workflowScriptInputShape,
    async execute(args, context) {
      let script: string
      try {
        script = await resolveScriptSource(args, context.directory)
      } catch (error) {
        return `workflow script rejected: ${error instanceof Error ? error.message : String(error)}`
      }
      let meta
      try {
        meta = parseWorkflowScript(script).meta
      } catch (error) {
        return `workflow script rejected: ${error instanceof Error ? error.message : String(error)}`
      }
      const runner = createSdkRunner(input.client, context.sessionID, { directory: context.directory })
      const progress = new WorkflowProgress({
        name: meta.name,
        plannedPhases: meta.phases?.map((phase) => phase.title),
        sink: (update) => context.metadata(update),
      })
      progress.flush()
      // Minted here, outside the script sandbox, so failure results can still
      // report the run id for resuming.
      const runId = generateRunId()
      try {
        const result = await runWorkflowScript({
          script,
          args: args.args,
          runner,
          abort: context.abort,
          workingDirectory: context.directory,
          defaultAgent: args.agent ?? defaults.workerAgent ?? "general",
          model: args.model ?? defaults.model ?? (await runner.resolveParentModel?.()),
          budgetTokens: args.budgetTokens ?? null,
          runId,
          resumeFromRunId: args.resumeFromRunId,
          events: {
            onPhase: (title) => progress.phase(title),
            onLog: (message) => progress.log(message),
            onAgentStart: (event) => progress.agentStart(event),
            onAgentEnd: (event) => progress.agentEnd(event),
            onChildSession: (child) => progress.childSession(child),
          },
        })
        progress.finish("completed")
        return formatScriptResult(result, Boolean(context.directory))
      } catch (error) {
        progress.finish(context.abort.aborted ? "aborted" : "failed")
        if (error instanceof WorkflowScriptError) {
          return [
            `workflow "${meta.name}" failed: ${error.message}`,
            formatScriptResult(error.partial, Boolean(context.directory)),
          ].join("\n")
        }
        return [
          `workflow "${meta.name}" failed: ${error instanceof Error ? error.message : String(error)}`,
          runIdLine(runId, Boolean(context.directory)),
        ].join("\n")
      }
    },
  })
}

/**
 * Read the script from `script` or `scriptPath`, requiring exactly one.
 * A bare name in `scriptPath` resolves through the same saved-workflow lookup
 * that workflow() uses, so a workflow can be launched the same way from either
 * side.
 */
async function resolveScriptSource(
  args: { script?: string; scriptPath?: string },
  directory: string | undefined,
): Promise<string> {
  if (args.script && args.scriptPath) {
    throw new Error("pass either script or scriptPath, not both.")
  }
  if (args.script) return args.script
  if (!args.scriptPath) throw new Error("one of script or scriptPath is required.")
  return loadWorkflowScriptFile(args.scriptPath, directory)
}

/**
 * Journaling - and therefore resuming - needs a working directory. Advertising
 * a Run ID without one promises a resume that would be rejected with "requires
 * a working directory" later.
 */
function runIdLine(runId: string, resumable: boolean): string {
  return resumable
    ? `Run ID: ${runId} - pass resumeFromRunId to resume`
    : `Run ID: ${runId} - not resumable: no working directory, so no journal was written`
}

function formatScriptResult(result: WorkflowScriptResult, resumable: boolean): string {
  const lines: string[] = []
  lines.push(`Workflow: ${result.meta.name}`)
  lines.push(runIdLine(result.runId, resumable))
  lines.push(`Agents spawned: ${result.agentCount}`)
  if (result.tokensSpent > 0) lines.push(`Output tokens spent: ${result.tokensSpent}`)
  if (result.phases.length > 0) lines.push(`Phases: ${result.phases.join(" -> ")}`)
  if (result.logs.length > 0) {
    lines.push("Logs:")
    for (const log of result.logs) lines.push(`  - ${log}`)
  }
  if (result.children.length > 0) {
    // Labelled rather than a bare id list: this is how a user finds the one
    // subagent they care about and opens it with `opencode --session <id>`.
    lines.push("Child sessions:")
    for (const child of result.children) {
      lines.push(`  - ${child.phase ? `${child.phase} · ` : ""}${child.label}: ${child.sessionID}`)
    }
  }
  lines.push("Result:")
  lines.push(serializeValue(result.value))
  return lines.join("\n")
}

function serializeValue(value: unknown): string {
  if (value === undefined) return "(script returned no value)"
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function instrumentRunner(runner: SessionRunner, progress: WorkflowProgress): SessionRunner {
  let nextID = 0
  const active = new Map<string, { id: number; label: string; phase?: string }>()
  return {
    async createChildSession(input) {
      const session = await runner.createChildSession(input)
      const phase = phaseFromTitle(input.title)
      progress.phase(phase)
      nextID += 1
      const info = { id: nextID, label: input.title, phase }
      active.set(session.sessionID, info)
      progress.agentStart(info)
      return session
    },
    async runChildSession(input) {
      try {
        const result = await runner.runChildSession(input)
        const info = active.get(input.sessionID)
        if (info) progress.agentEnd({ ...info, ok: !result.error })
        return result
      } catch (error) {
        const info = active.get(input.sessionID)
        if (info) progress.agentEnd({ ...info, ok: false })
        throw error
      }
    },
    deleteSession: (sessionID) => runner.deleteSession(sessionID),
  }
}

function phaseFromTitle(title: string): string {
  if (title.startsWith("Workflow planner")) return "Plan"
  if (title.startsWith("Workflow reviewer")) return "Review"
  return "Work"
}

function toResolvedDefaults(options: DynamicWorkflowOptions): ResolvedWorkflowOptions {
  return {
    mode: "research",
    allowEdits: options.allowEdits ?? false,
    maxRounds: options.maxRounds ?? 3,
    maxWorkers: options.maxWorkers ?? 3,
    maxTasks: options.maxTasks ?? 20,
    parallelWorkers: options.parallelWorkers ?? true,
    plannerAgent: options.plannerAgent ?? "plan",
    workerAgent: options.workerAgent ?? "general",
    reviewerAgent: options.reviewerAgent ?? "general",
    model: options.model,
    successCriteria: [],
  }
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value
  return value.slice(0, max - 1) + "\u2026"
}
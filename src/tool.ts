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
import { runWorkflowScript, WorkflowScriptError, type WorkflowScriptResult } from "./script/engine.js"

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
        model: args.model ?? defaults.model,
        successCriteria: criteria,
      })
      const parent = context.sessionID
      const runner = createSdkRunner(input.client, parent, { directory: context.directory })
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
  "agent(prompt, opts?) -> Promise<string|object|null>: spawn a subagent as an OpenCode child session; opts {label, phase, schema, model, agentType}. With schema (JSON Schema) the return is a validated object; returns null on agent failure.",
  "parallel(thunks) -> Promise<any[]>: run zero-arg async functions concurrently (barrier); a thunk that throws resolves to null - filter with .filter(Boolean).",
  "pipeline(items, ...stages) -> Promise<any[]>: run each item through all stages independently with NO barrier between stages; each stage receives (prevResult, originalItem, index); a throwing stage drops the item to null. DEFAULT to pipeline for multi-stage work.",
  "phase(title): group subsequent agent() calls under this roadmap phase. log(message): emit a progress line. args: the value passed as this tool's `args` input. budget: {total, spent(), remaining()} tracking output tokens against `budgetTokens`.",
  "Use the SAME phase titles in meta.phases as in phase() calls. The roadmap renders live in the TUI while the workflow runs.",
  "Concurrency is capped per workflow; excess agent() calls queue. Lifetime cap 1000 agents, 4096 items per parallel/pipeline call.",
  "Use this for multi-step orchestration where control flow should be deterministic (loops, conditionals, fan-out) rather than model-driven.",
].join(" ")

const workflowScriptInputShape = {
  script: z.string().min(1)
    .describe("Self-contained workflow script starting with `export const meta = {...}` followed by the body using agent()/parallel()/pipeline()/phase()/log()."),
  args: z.unknown().optional()
    .describe("Optional input exposed to the script as the global `args`, verbatim. Pass arrays/objects as JSON values, not stringified."),
  budgetTokens: z.number().int().min(1).optional()
    .describe("Optional hard output-token ceiling for the run; exposed to the script as budget.total."),
  agent: z.string().optional()
    .describe("Default OpenCode agent for agent() calls (opts.agentType overrides per call). Defaults to 'general' or your plugin config."),
  model: z.string().optional()
    .describe("Optional 'provider/model-id' override for all child sessions."),
}

export function createWorkflowScriptTool(input: CreateToolInput) {
  const defaults = input.pluginOptions
  return tool({
    description: WORKFLOW_SCRIPT_DESCRIPTION,
    args: workflowScriptInputShape,
    async execute(args, context) {
      let meta
      try {
        meta = parseWorkflowScript(args.script).meta
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
      try {
        const result = await runWorkflowScript({
          script: args.script,
          args: args.args,
          runner,
          abort: context.abort,
          defaultAgent: args.agent ?? defaults.workerAgent ?? "general",
          model: args.model ?? defaults.model,
          budgetTokens: args.budgetTokens ?? null,
          events: {
            onPhase: (title) => progress.phase(title),
            onLog: (message) => progress.log(message),
            onAgentStart: (event) => progress.agentStart(event),
            onAgentEnd: (event) => progress.agentEnd(event),
          },
        })
        progress.finish("completed")
        return formatScriptResult(result)
      } catch (error) {
        progress.finish(context.abort.aborted ? "aborted" : "failed")
        if (error instanceof WorkflowScriptError) {
          return [
            `workflow "${meta.name}" failed: ${error.message}`,
            formatScriptResult(error.partial),
          ].join("\n")
        }
        return `workflow "${meta.name}" failed: ${error instanceof Error ? error.message : String(error)}`
      }
    },
  })
}

function formatScriptResult(result: WorkflowScriptResult): string {
  const lines: string[] = []
  lines.push(`Workflow: ${result.meta.name}`)
  lines.push(`Agents spawned: ${result.agentCount}`)
  if (result.tokensSpent > 0) lines.push(`Output tokens spent: ${result.tokensSpent}`)
  if (result.phases.length > 0) lines.push(`Phases: ${result.phases.join(" -> ")}`)
  if (result.logs.length > 0) {
    lines.push("Logs:")
    for (const log of result.logs) lines.push(`  - ${log}`)
  }
  if (result.sessionIDs.length > 0) {
    lines.push(`Child sessions: ${result.sessionIDs.join(", ")}`)
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
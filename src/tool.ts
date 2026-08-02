import { tool } from "@opencode-ai/plugin"
import { z } from "zod"
import { resolveOptions } from "./options.js"
import { runWorkflow } from "./orchestrator.js"
import { formatError, formatWorkflowResult } from "./format.js"
import type { DynamicWorkflowOptions, ResolvedWorkflowOptions } from "./types.js"
import { createSdkRunner, type OpencodeClientLike } from "./runtime/sdk.js"

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
      try {
        const result = await runWorkflow({
          goal: args.goal,
          parentSessionID: parent,
          runner,
          abort: context.abort,
          options,
          successCriteria: criteria,
        })
        return formatWorkflowResult(result)
      } catch (error) {
        return formatError("dynamic_workflow failed", error, { goal: args.goal, mode: options.mode })
      }
    },
  })
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
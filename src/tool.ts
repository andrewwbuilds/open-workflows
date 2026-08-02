import { tool } from "@opencode-ai/plugin"
import { z } from "zod"
import { resolveOptions } from "./options.js"
import { runWorkflow } from "./orchestrator.js"
import { formatWorkflowResult } from "./format.js"
import type { DynamicWorkflowOptions, ResolvedWorkflowOptions } from "./types.js"
import { createSdkRunner, type OpencodeClientLike } from "./runtime/sdk.js"

export interface CreateToolInput {
  client: OpencodeClientLike
  pluginOptions: DynamicWorkflowOptions
}

const dynamicWorkflowInputShape = {
  goal: z.string().min(1).describe("The objective the workflow should accomplish."),
  mode: z.enum(["research", "implement", "review"]).optional()
    .describe("Workflow mode. Defaults to research."),
  allowEdits: z.boolean().optional()
    .describe("Allow workers to edit the worktree. Defaults to false. Use 'implement' to actually change code."),
  maxRounds: z.number().int().min(1).max(10).optional()
    .describe("Maximum planner-reviewer loop count."),
  maxWorkers: z.number().int().min(1).max(8).optional()
    .describe("Maximum workers per round (split between research and edit tasks)."),
  maxTasks: z.number().int().min(1).max(50).optional()
    .describe("Maximum tasks accepted from the planner each round."),
  parallelWorkers: z.boolean().optional()
    .describe("Run read-only workers concurrently. Editing workers are always serial."),
  successCriteria: z.array(z.string()).optional()
    .describe("Optional explicit criteria the reviewer checks against."),
  plannerAgent: z.string().optional()
    .describe("OpenCode agent used for planning. Defaults to 'plan'."),
  workerAgent: z.string().optional()
    .describe("Default OpenCode agent for workers."),
  reviewerAgent: z.string().optional()
    .describe("OpenCode agent used for review."),
  model: z.string().optional()
    .describe("Optional 'provider/model-id' override for child sessions."),
}

export function createDynamicWorkflowTool(input: CreateToolInput) {
  const defaults = resolveOptions(toResolvedDefaults(input.pluginOptions))

  return tool({
    description:
      "Run a coordinated OpenCode workflow with planner, worker, and reviewer agents. " +
      "Use this for multi-step research or implementation tasks that benefit from decomposition, " +
      "parallel exploration, and a reviewer pass before completion.",
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
      const result = await runWorkflow({
        goal: args.goal,
        parentSessionID: parent,
        runner,
        abort: context.abort,
        options,
        successCriteria: criteria,
      })
      return formatWorkflowResult(result)
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


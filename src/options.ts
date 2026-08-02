import type { ResolvedWorkflowOptions } from "./types.js"

const DEFAULT_MAX_ROUNDS = 3
const DEFAULT_MAX_WORKERS = 3
const DEFAULT_MAX_TASKS = 20
const MAX_HARD_TASKS = 50
const MAX_HARD_WORKERS = 8
const MAX_HARD_ROUNDS = 10

export function resolveOptions(
  options: ResolvedWorkflowOptions | undefined,
): ResolvedWorkflowOptions {
  return {
    mode: options?.mode ?? "research",
    allowEdits: options?.allowEdits ?? false,
    maxRounds: clamp(options?.maxRounds ?? DEFAULT_MAX_ROUNDS, 1, MAX_HARD_ROUNDS),
    maxWorkers: clamp(options?.maxWorkers ?? DEFAULT_MAX_WORKERS, 1, MAX_HARD_WORKERS),
    maxTasks: clamp(options?.maxTasks ?? DEFAULT_MAX_TASKS, 1, MAX_HARD_TASKS),
    parallelWorkers: options?.parallelWorkers ?? true,
    plannerAgent: options?.plannerAgent ?? "plan",
    workerAgent: options?.workerAgent ?? "general",
    reviewerAgent: options?.reviewerAgent ?? "general",
    model: options?.model,
    successCriteria: options?.successCriteria ?? [],
  }
}

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value) || value < min) return min
  if (value > max) return max
  return Math.floor(value)
}

import type { ResolvedWorkflowOptions, TaskKind, WorkflowTask } from "../types.js"
import { generateId } from "./id.js"

export function normalizePlannerTasks(
  plan: WorkflowTask[],
  options: ResolvedWorkflowOptions,
): WorkflowTask[] {
  const allowedKinds = options.allowEdits
    ? new Set(["research", "edit", "test", "review"])
    : new Set(["research", "test", "review"])
  const seen = new Set<string>()
  const result: WorkflowTask[] = []
  for (const task of plan) {
    if (!task || typeof task !== "object") continue
    const id = (task.id && String(task.id).trim()) || generateId("task")
    if (seen.has(id)) continue
    seen.add(id)
    const kind = task.kind
    if (typeof kind !== "string" || !allowedKinds.has(kind as TaskKind)) continue
    const description = typeof task.description === "string" ? task.description.trim() : ""
    if (description.length === 0) continue
    const title = (task.title && String(task.title).trim()) || description.slice(0, 80)
    const dependsOn = Array.isArray(task.dependsOn)
      ? task.dependsOn.filter((dep: unknown): dep is string => typeof dep === "string")
      : []
    const acceptance = Array.isArray(task.acceptance)
      ? task.acceptance.filter((line: unknown): line is string => typeof line === "string")
      : []
    const agent = typeof task.agent === "string" && task.agent.trim().length > 0 ? task.agent : undefined
    result.push({ id, title, description, kind: kind as TaskKind, dependsOn, acceptance, agent })
    if (result.length >= options.maxTasks) break
  }
  return result
}

export function normalizeReviewerFollowUps(
  followUps: unknown,
  options: ResolvedWorkflowOptions,
): WorkflowTask[] {
  if (!Array.isArray(followUps)) return []
  return normalizePlannerTasks(followUps as WorkflowTask[], options)
}

export function inferStatus(input: unknown): "completed" | "needs-attention" | "blocked" {
  if (typeof input !== "string") return "completed"
  const value = input.toLowerCase()
  if (value.includes("blocked")) return "blocked"
  if (value.includes("needs-attention") || value.includes("needs attention") || value.includes("partial")) {
    return "needs-attention"
  }
  return "completed"
}
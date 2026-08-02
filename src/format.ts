import type { ResolvedWorkflowOptions, WorkflowResult } from "./types.js"

export interface FormatResultOptions {
  truncateRounds?: number
  maxChars?: number
}

const DEFAULT_MAX_CHARS = 8000

export function formatWorkflowResult(
  result: WorkflowResult,
  options: FormatResultOptions = {},
): string {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS
  const truncateRounds = options.truncateRounds ?? 2
  const lines: string[] = []
  lines.push(`Workflow status: ${result.status}`)
  lines.push(`Goal: ${result.goal}`)
  lines.push(`Mode: ${result.mode}`)
  lines.push(`Rounds: ${result.rounds.length}`)
  const recent = result.rounds.slice(-truncateRounds)
  for (const round of recent) {
    lines.push("")
    lines.push(`Round ${round.round}:`)
    if (round.plannerSessionID) lines.push(`  planner: ${round.plannerSessionID}`)
    for (const worker of round.workerSessionIDs) {
      lines.push(`  worker:  ${worker}`)
    }
    if (round.reviewerSessionID) lines.push(`  reviewer: ${round.reviewerSessionID}`)
    for (const task of round.tasks) {
      lines.push(
        `  - [${task.status}] ${task.id} (${task.kind}) ${task.title}` +
          (task.sessionID ? ` -> ${task.sessionID}` : ""),
      )
      if (task.summary) {
        lines.push(`      ${summarize(task.summary)}`)
      }
    }
    if (round.review) {
      lines.push(`  review: ${round.review.status} - ${round.review.summary}`)
      if (round.review.criteriaMissed.length > 0) {
        lines.push("  missed:")
        for (const criterion of round.review.criteriaMissed) {
          lines.push(`    - ${criterion}`)
        }
      }
    }
  }
  if (result.rounds.length > recent.length) {
    lines.push("")
    lines.push(`(${result.rounds.length - recent.length} earlier round(s) omitted)`)
  }
  lines.push("")
  lines.push(`Final: ${result.finalSummary}`)
  let text = lines.join("\n")
  if (text.length > maxChars) {
    text = text.slice(0, maxChars) + "\n... (truncated)"
  }
  return text
}

function summarize(summary: string): string {
  const trimmed = summary.replace(/\s+/g, " ").trim()
  if (trimmed.length <= 220) return trimmed
  return trimmed.slice(0, 217) + "..."
}

export function summarizeOptions(options: ResolvedWorkflowOptions): string {
  return [
    `mode=${options.mode}`,
    `allowEdits=${options.allowEdits}`,
    `maxRounds=${options.maxRounds}`,
    `maxWorkers=${options.maxWorkers}`,
    `maxTasks=${options.maxTasks}`,
    `parallelWorkers=${options.parallelWorkers}`,
    `plannerAgent=${options.plannerAgent}`,
    `workerAgent=${options.workerAgent}`,
    `reviewerAgent=${options.reviewerAgent}`,
  ].join(" ")
}

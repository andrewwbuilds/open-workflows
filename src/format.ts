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
      if (round.review.criteriaMet.length > 0) {
        lines.push("  met:")
        for (const criterion of round.review.criteriaMet) {
          lines.push(`    - ${criterion}`)
        }
      }
      if (round.review.criteriaMissed.length > 0) {
        lines.push("  missed:")
        for (const criterion of round.review.criteriaMissed) {
          lines.push(`    - ${criterion}`)
        }
      }
      if (round.review.followUps.length > 0) {
        lines.push("  follow-ups:")
        for (const followUp of round.review.followUps) {
          lines.push(`    - [${followUp.kind}] ${followUp.id}: ${followUp.title}`)
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

export interface FormatErrorContext {
  goal: string
  mode: string
}

export function formatError(
  title: string,
  error: unknown,
  context: FormatErrorContext,
): string {
  const message = error instanceof Error ? error.message : String(error)
  return [
    `${title}.`,
    `Goal: ${context.goal}`,
    `Mode: ${context.mode}`,
    `Error: ${message}`,
    "Check the OpenCode logs for the full stack trace. Common causes:",
    "- The configured planner/worker/reviewer agents don't exist (default 'plan' / 'general').",
    "- The model id is invalid for your providers.",
    "- A child session was aborted or hit a tool permission gate.",
  ].join("\n")
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
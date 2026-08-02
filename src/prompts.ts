import type { PlannerOutput, ReviewerOutput, ResolvedWorkflowOptions, TaskStatus, WorkerOutput, WorkflowTask } from "./types.js"

export function buildPlannerPrompt(args: {
  goal: string
  round: number
  previousReview?: ReviewerOutput
  successCriteria: string[]
  options: ResolvedWorkflowOptions
}): string {
  const { goal, round, previousReview, successCriteria, options } = args
  const sections: string[] = []
  sections.push("You are the planner in a coordinated OpenCode workflow.")
  sections.push(`Round ${round} of ${options.maxRounds}.`)
  sections.push(`Workflow mode: ${options.mode}.`)
  sections.push(`Allow edits: ${options.allowEdits ? "yes" : "no"}.`)
  if (successCriteria.length > 0) {
    sections.push("Success criteria:")
    for (const criterion of successCriteria) {
      sections.push(`- ${criterion}`)
    }
  }
  if (previousReview) {
    sections.push("Previous reviewer feedback:")
    sections.push(`Status: ${previousReview.status}`)
    sections.push(`Summary: ${previousReview.summary}`)
    if (previousReview.criteriaMissed.length > 0) {
      sections.push("Missed criteria:")
      for (const criterion of previousReview.criteriaMissed) {
        sections.push(`- ${criterion}`)
      }
    }
  }
  sections.push("Goal:")
  sections.push(goal)
  sections.push("Respond with a JSON object only. Schema:")
  sections.push(
    JSON.stringify(
      {
        plan: [
          {
            id: "task-1",
            title: "short title",
            description: "concrete instructions for a worker",
            kind: "research | edit | test | review",
            agent: "optional agent name",
            dependsOn: ["optional", "ids"],
            acceptance: ["optional", "verifiable acceptance criteria"],
          },
        ],
        rationale: "Why this plan satisfies the goal in this round.",
      },
      null,
      2,
    ),
  )
  sections.push("Rules:")
  sections.push("- Produce at most 12 tasks in this round.")
  sections.push(
    options.allowEdits
      ? "- You may include edit tasks. Editing workers run serially; research workers may run in parallel."
      : "- You must not include edit tasks. Workers are read-only in this workflow.",
  )
  sections.push("- Set dependsOn to ensure parallel safety.")
  sections.push("- Reuse or remove prior task ids when continuing work.")
  return sections.join("\n\n")
}

export function buildWorkerPrompt(args: {
  goal: string
  task: WorkflowTask
  parentTitle: string
  options: ResolvedWorkflowOptions
}): string {
  const { goal, task, parentTitle, options } = args
  const lines: string[] = []
  lines.push(`You are a worker in the workflow "${parentTitle}".`)
  lines.push("Workflow mode: " + options.mode)
  lines.push("Editing allowed: " + (options.allowEdits && task.kind === "edit" ? "yes" : "no"))
  lines.push("Original goal:")
  lines.push(goal)
  lines.push("Your task:")
  lines.push(`- id: ${task.id}`)
  lines.push(`- title: ${task.title}`)
  lines.push(`- kind: ${task.kind}`)
  lines.push(`- description: ${task.description}`)
  if (task.dependsOn && task.dependsOn.length > 0) {
    lines.push(`- depends on: ${task.dependsOn.join(", ")}`)
  }
  if (task.acceptance && task.acceptance.length > 0) {
    lines.push("Acceptance criteria:")
    for (const criterion of task.acceptance) {
      lines.push(`- ${criterion}`)
    }
  }
  lines.push("Respond with a JSON object only:")
  lines.push(
    JSON.stringify(
      {
        status: "completed | needs-attention | blocked",
        summary: "Concise factual summary of what you found or changed.",
      },
      null,
      2,
    ),
  )
  lines.push("Hard rules:")
  lines.push("- Do not commit, push, reset, rebase, or delete files outside the task scope.")
  lines.push("- Do not launch additional subagents through the task tool.")
  lines.push("- Do not modify files unrelated to this task.")
  return lines.join("\n")
}

export function buildReviewerPrompt(args: {
  goal: string
  round: number
  options: ResolvedWorkflowOptions
  successCriteria: string[]
  workerSummaries: Array<{ task: WorkflowTask; status: TaskStatus; summary: string }>
}): string {
  const { goal, round, options, successCriteria, workerSummaries } = args
  const lines: string[] = []
  lines.push("You are the reviewer in a coordinated OpenCode workflow.")
  lines.push(`Round ${round} of ${options.maxRounds}.`)
  lines.push("Workflow mode: " + options.mode)
  lines.push("Original goal:")
  lines.push(goal)
  if (successCriteria.length > 0) {
    lines.push("Success criteria:")
    for (const criterion of successCriteria) {
      lines.push(`- ${criterion}`)
    }
  }
  lines.push("Worker reports:")
  for (const entry of workerSummaries) {
    lines.push(
      `- [${entry.task.id}] ${entry.task.title} (${entry.task.kind}, status=${entry.status}): ${entry.summary}`,
    )
  }
  lines.push("Respond with a JSON object only:")
  lines.push(
    JSON.stringify(
      {
        status: "pass | needs-attention | blocked",
        summary: "Concise factual assessment of the work so far.",
        criteriaMet: ["success criteria that are now satisfied"],
        criteriaMissed: ["success criteria still unmet"],
        followUps: [
          {
            id: "next-task-1",
            title: "next action",
            description: "concrete instructions for a worker",
            kind: "research | edit | test | review",
            dependsOn: ["optional", "ids"],
            acceptance: ["optional", "verifiable acceptance criteria"],
          },
        ],
      },
      null,
      2,
    ),
  )
  lines.push("Rules:")
  lines.push("- Use status 'pass' only when every success criterion is met and the work is coherent.")
  lines.push("- Use status 'needs-attention' when follow-up tasks are needed in a later round.")
  lines.push("- Use status 'blocked' when workers must stop and request user input.")
  lines.push("- Do not launch additional subagents through the task tool.")
  return lines.join("\n")
}

export function buildFallbackPlannerOutput(): PlannerOutput {
  return {
    plan: [],
    rationale: "Planner did not return a structured plan; defaulting to no new tasks.",
  }
}

export function buildFallbackReviewerOutput(summary: string): ReviewerOutput {
  return {
    status: "needs-attention",
    summary,
    followUps: [],
    criteriaMet: [],
    criteriaMissed: [],
  }
}

export function buildFallbackWorkerOutput(summary: string): WorkerOutput {
  return {
    status: "completed",
    summary,
  }
}

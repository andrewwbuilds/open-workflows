export type WorkflowMode = "research" | "implement" | "review"

export type TaskStatus = "pending" | "completed" | "needs-attention" | "blocked"

export type TaskKind = "research" | "edit" | "test" | "review"

export interface WorkflowTask {
  id: string
  title: string
  description: string
  agent?: string
  kind: TaskKind
  dependsOn?: string[]
  acceptance?: string[]
}

export interface ReviewerOutput {
  status: "pass" | "needs-attention" | "blocked"
  summary: string
  followUps: WorkflowTask[]
  criteriaMet: string[]
  criteriaMissed: string[]
}

export interface WorkerOutput {
  status: "completed" | "needs-attention" | "blocked"
  summary: string
}

export interface PlannerOutput {
  plan: WorkflowTask[]
  rationale: string
}

export interface WorkflowRoundSummary {
  round: number
  plannerSessionID?: string
  workerSessionIDs: string[]
  reviewerSessionID?: string
  tasks: Array<WorkflowTask & { status: TaskStatus; summary?: string; sessionID?: string }>
  review?: ReviewerOutput
}

export interface WorkflowResult {
  goal: string
  mode: WorkflowMode
  status: "completed" | "needs-attention" | "blocked" | "budget-exhausted" | "aborted"
  rounds: WorkflowRoundSummary[]
  finalSummary: string
  artifacts: {
    plannerSessionID?: string
    workerSessionIDs: string[]
    reviewerSessionIDs: string[]
  }
}

export interface DynamicWorkflowArgs {
  goal: string
  mode?: WorkflowMode
  allowEdits?: boolean
  maxRounds?: number
  maxWorkers?: number
  maxTasks?: number
  parallelWorkers?: boolean
  successCriteria?: string[]
  plannerAgent?: string
  workerAgent?: string
  reviewerAgent?: string
  model?: string
}

export interface DynamicWorkflowOptions {
  plannerAgent?: string
  workerAgent?: string
  reviewerAgent?: string
  maxRounds?: number
  maxWorkers?: number
  maxTasks?: number
  allowEdits?: boolean
  parallelWorkers?: boolean
  model?: string
}

export interface ResolvedWorkflowOptions {
  mode: WorkflowMode
  allowEdits: boolean
  maxRounds: number
  maxWorkers: number
  maxTasks: number
  parallelWorkers: boolean
  plannerAgent: string
  workerAgent: string
  reviewerAgent: string
  model: string | undefined
  successCriteria: string[]
}

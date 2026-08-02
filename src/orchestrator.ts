import type { ReviewerOutput, TaskStatus, WorkflowResult, WorkflowRoundSummary, WorkflowTask } from "./types.js"
import { buildFallbackPlannerOutput, buildFallbackReviewerOutput, buildPlannerPrompt, buildReviewerPrompt, buildWorkerPrompt } from "./prompts.js"
import { normalizePlannerTasks } from "./util/normalize.js"
import { isPlannerOutput, isReviewerOutput, parseStructuredOutput } from "./util/parse.js"
import { resolveOptions } from "./options.js"
import type { ResolvedWorkflowOptions } from "./types.js"
import type { CreateChildSessionInput, SessionRunner } from "./runtime/types.js"

export interface RunWorkflowInput {
  goal: string
  parentSessionID: string
  runner: SessionRunner
  abort?: AbortSignal
  options: ResolvedWorkflowOptions
  successCriteria?: string[]
  onRound?: (round: WorkflowRoundSummary) => void
}

export async function runWorkflow(input: RunWorkflowInput): Promise<WorkflowResult> {
  const resolved = resolveOptions(input.options)
  const criteria = input.successCriteria ?? resolved.successCriteria
  const parentTitle = input.goal.length > 60 ? input.goal.slice(0, 57) + "..." : input.goal

  const rounds: WorkflowRoundSummary[] = []
  const workerSessionIDs: string[] = []
  const reviewerSessionIDs: string[] = []
  let plannerSessionID: string | undefined
  let previousReview: ReviewerOutput | undefined
  let lastStatus: WorkflowResult["status"] = "needs-attention"

  for (let round = 1; round <= resolved.maxRounds; round += 1) {
    if (input.abort?.aborted) {
      lastStatus = "aborted"
      break
    }

    const plannerSession = await createAgentSession(input.runner, {
      title: `Workflow planner: round ${round}`,
      agent: resolved.plannerAgent,
      model: resolved.model,
    })
    plannerSessionID = plannerSession.sessionID

    const plannerPrompt = buildPlannerPrompt({
      goal: input.goal,
      round,
      previousReview,
      successCriteria: criteria,
      options: resolved,
    })
    const plannerResult = await runAgent(input.runner, plannerSession, {
      title: "Plan workflow",
      agent: resolved.plannerAgent,
      model: resolved.model,
      prompt: plannerPrompt,
      abort: input.abort,
    })
    const plannerOutput = parseStructuredOutput(plannerResult.text, isPlannerOutput)
      ?? buildFallbackPlannerOutput()
    const tasks = normalizePlannerTasks(plannerOutput.plan, resolved)
    const roundWorkerSessions: string[] = []

    if (tasks.length === 0) {
      const reviewerSession = await createAgentSession(input.runner, {
        title: `Workflow reviewer: round ${round} (idle)`,
        agent: resolved.reviewerAgent,
        model: resolved.model,
      })
      const reviewerPrompt = buildReviewerPrompt({
        goal: input.goal,
        round,
        options: resolved,
        successCriteria: criteria,
        workerSummaries: [],
      })
      const reviewerResult = await runAgent(input.runner, reviewerSession, {
        title: "Review workflow",
        agent: resolved.reviewerAgent,
        model: resolved.model,
        prompt: reviewerPrompt,
        abort: input.abort,
      })
      reviewerSessionIDs.push(reviewerSession.sessionID)
      const review = parseStructuredOutput(reviewerResult.text, isReviewerOutput)
        ?? buildFallbackReviewerOutput(plannerOutput.rationale || "Planner returned no tasks.")
      const summary: WorkflowRoundSummary = {
        round,
        plannerSessionID: plannerSession.sessionID,
        workerSessionIDs: [],
        reviewerSessionID: reviewerSession.sessionID,
        tasks: [],
        review,
      }
      rounds.push(summary)
      input.onRound?.(summary)
      previousReview = review
      lastStatus = review.status === "pass" ? "completed" : "needs-attention"
      if (review.status === "blocked") {
        lastStatus = "blocked"
        break
      }
      continue
    }

    const editTasks = tasks.filter((task) => task.kind === "edit")
    const nonEditTasks = tasks.filter((task) => task.kind !== "edit")
    const boundedEdit = editTasks.slice(0, resolved.maxWorkers)
    const boundedNonEdit = nonEditTasks.slice(0, resolved.maxWorkers)
    const bounded = [...boundedNonEdit, ...boundedEdit]

    const taskResults = new Map<string, { status: TaskStatus; summary: string; sessionID: string }>()

    const ready = (task: WorkflowTask): boolean => {
      if (!task.dependsOn || task.dependsOn.length === 0) return true
      return task.dependsOn.every((dep) => taskResults.has(dep))
    }

    const remaining: WorkflowTask[] = [...bounded]
    let inFlight: Array<Promise<void>> = []

    const canRunParallel = (task: WorkflowTask) =>
      resolved.parallelWorkers && task.kind !== "edit" && (!task.dependsOn || task.dependsOn.length === 0)

    const startTask = async (task: WorkflowTask): Promise<void> => {
      const session = await createAgentSession(input.runner, {
        title: `Workflow worker: ${truncate(task.title, 50)}`,
        agent: task.agent ?? resolved.workerAgent,
        model: resolved.model,
      })
      roundWorkerSessions.push(session.sessionID)
      workerSessionIDs.push(session.sessionID)
      const prompt = buildWorkerPrompt({
        goal: input.goal,
        task,
        parentTitle,
        options: resolved,
      })
      const result = await runAgent(input.runner, session, {
        title: truncate(task.title, 50),
        agent: task.agent ?? resolved.workerAgent,
        model: resolved.model,
        prompt,
        abort: input.abort,
      })
      taskResults.set(task.id, {
        status: inferStatusFromText(result.text),
        summary: result.text || "Worker returned no text.",
        sessionID: session.sessionID,
      })
    }

    const scheduleReady = () => {
      for (let i = 0; i < remaining.length; i += 1) {
        const task = remaining[i]
        if (!task) continue
        if (!ready(task)) continue
        const parallel = canRunParallel(task)
        remaining.splice(i, 1)
        i -= 1
        const work = startTask(task).then(() => {
          inFlight = inFlight.filter((p) => p !== work)
          scheduleReady()
        })
        inFlight.push(work)
        if (!parallel) {
          // Edit tasks always run serially. We rely on awaited work to
          // enforce ordering without busy-waiting the event loop.
        }
      }
    }

    scheduleReady()
    while (inFlight.length > 0) {
      const current = inFlight
      await Promise.race(current)
    }

    const reviewerSession = await createAgentSession(input.runner, {
      title: `Workflow reviewer: round ${round}`,
      agent: resolved.reviewerAgent,
      model: resolved.model,
    })
    const workerSummaries = bounded.map((task) => {
      const result = taskResults.get(task.id)
      return {
        task,
        status: result?.status ?? ("needs-attention" as TaskStatus),
        summary: result?.summary ?? "Worker did not complete.",
      }
    })
    const reviewerPrompt = buildReviewerPrompt({
      goal: input.goal,
      round,
      options: resolved,
      successCriteria: criteria,
      workerSummaries,
    })
    const reviewerResult = await runAgent(input.runner, reviewerSession, {
      title: "Review workflow",
      agent: resolved.reviewerAgent,
      model: resolved.model,
      prompt: reviewerPrompt,
      abort: input.abort,
    })
    reviewerSessionIDs.push(reviewerSession.sessionID)
    const review = parseStructuredOutput(reviewerResult.text, isReviewerOutput)
      ?? buildFallbackReviewerOutput(
        reviewerResult.text || "Reviewer did not return a structured assessment.",
      )

    const summary: WorkflowRoundSummary = {
      round,
      plannerSessionID: plannerSession.sessionID,
      workerSessionIDs: roundWorkerSessions,
      reviewerSessionID: reviewerSession.sessionID,
      tasks: bounded.map((task) => {
        const result = taskResults.get(task.id)
        return {
          ...task,
          status: result?.status ?? "needs-attention",
          summary: result?.summary,
          sessionID: result?.sessionID,
        }
      }),
      review,
    }
    rounds.push(summary)
    input.onRound?.(summary)
    previousReview = review

    if (review.status === "blocked") {
      lastStatus = "blocked"
      break
    }
    if (review.status === "pass") {
      lastStatus = "completed"
      break
    }
    if (round === resolved.maxRounds) {
      lastStatus = "budget-exhausted"
    }
  }

  return {
    goal: input.goal,
    mode: resolved.mode,
    status: lastStatus,
    rounds,
    finalSummary: buildFinalSummary(rounds, lastStatus, input.goal),
    artifacts: {
      plannerSessionID,
      workerSessionIDs,
      reviewerSessionIDs,
    },
  }
}

interface CreateAgentSessionInput extends CreateChildSessionInput {
  model?: string
}

async function createAgentSession(
  runner: SessionRunner,
  input: CreateAgentSessionInput,
): Promise<{ sessionID: string }> {
  return runner.createChildSession(input)
}

interface RunAgentInput {
  title: string
  agent: string
  model?: string
  prompt: string
  abort?: AbortSignal
}

async function runAgent(
  runner: SessionRunner,
  session: { sessionID: string },
  input: RunAgentInput,
): Promise<{ text: string; error?: string }> {
  try {
    return await runner.runChildSession({
      sessionID: session.sessionID,
      agent: input.agent,
      model: input.model,
      prompt: input.prompt,
      abort: input.abort,
    })
  } catch (error) {
    return { text: "", error: errorMessage(error) }
  }
}

function inferStatusFromText(text: string): TaskStatus {
  if (!text) return "needs-attention"
  const lower = text.toLowerCase()
  if (lower.includes("\"status\": \"blocked\"") || lower.includes("status: blocked") || lower.includes("status is blocked")) {
    return "blocked"
  }
  if (
    lower.includes("\"status\": \"needs-attention\"")
    || lower.includes("status: needs-attention")
    || lower.includes("status is needs-attention")
  ) {
    return "needs-attention"
  }
  if (lower.includes("\"status\": \"completed\"") || lower.includes("status: completed") || lower.includes("status is completed")) {
    return "completed"
  }
  return "completed"
}

function buildFinalSummary(
  rounds: WorkflowRoundSummary[],
  status: WorkflowResult["status"],
  goal: string,
): string {
  if (rounds.length === 0) {
    return `Workflow for "${goal}" ended (${status}) with no rounds executed.`
  }
  const last = rounds[rounds.length - 1]
  if (!last?.review) {
    return `Workflow for "${goal}" ended (${status}) after ${rounds.length} round(s).`
  }
  return `Workflow for "${goal}" ended (${status}) after ${rounds.length} round(s). Last review: ${last.review.summary}`
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value
  return value.slice(0, max - 1) + "\u2026"
}

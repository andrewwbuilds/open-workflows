import type { ReviewerOutput, TaskStatus, WorkflowResult, WorkflowRoundSummary, WorkflowTask } from "./types.js"
import { buildFallbackPlannerOutput, buildFallbackReviewerOutput, buildPlannerPrompt, buildReviewerPrompt, buildWorkerPrompt } from "./prompts.js"
import { normalizePlannerTasks, normalizeReviewerFollowUps } from "./util/normalize.js"
import { isPlannerOutput, isReviewerOutput, parseStructuredOutput } from "./util/parse.js"
import { errorMessage } from "./util/error.js"
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

/**
 * Thrown internally when a child prompt is cancelled, to unwind the round loop
 * to the teardown below. Never escapes runWorkflow.
 */
class WorkflowAbortedError extends Error {
  constructor() {
    super("Workflow cancelled.")
    this.name = "WorkflowAbortedError"
  }
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
  let seedTasks: WorkflowTask[] = []
  let lastStatus: WorkflowResult["status"] = "needs-attention"
  /**
   * Child sessions with a turn in flight right now, so a cancelled run can stop
   * them server-side.
   *
   * Cancelling the caller's signal is NOT enough. Verified live against
   * opencode 1.15.10: there is no native parent -> child abort cascade, and a
   * child whose prompt fetch was cancelled still ran its turn to completion and
   * committed its tokens. POST /session/{childID}/abort is the only thing that
   * really stops a child - see SessionRunner.abortSession.
   */
  const liveSessions = new Set<string>()
  const stoppedSessionIDs: string[] = []
  const stopLiveSessions = async (): Promise<void> => {
    const stranded = [...liveSessions]
    liveSessions.clear()
    stoppedSessionIDs.push(...stranded)
    await Promise.all(stranded.map((sessionID) => input.runner.abortSession?.(sessionID)))
  }

  try {
    for (let round = 1; round <= resolved.maxRounds; round += 1) {
      if (input.abort?.aborted) throw new WorkflowAbortedError()

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
        seedTasks,
      })
      const plannerResult = await runAgent(input.runner, plannerSession, {
        title: "Plan workflow",
        agent: resolved.plannerAgent,
        model: resolved.model,
        prompt: plannerPrompt,
        abort: input.abort,
      }, liveSessions)
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
        }, liveSessions)
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
        seedTasks = normalizeReviewerFollowUps(review.followUps, resolved)
        lastStatus = review.status === "pass" ? "completed" : "needs-attention"
        if (review.status === "blocked") {
          lastStatus = "blocked"
          break
        }
        continue
      }

      const bounded = tasks.slice(0, resolved.maxWorkers * 2)
      const taskResults = new Map<string, { status: TaskStatus; summary: string; sessionID: string }>()

      const canRunParallel = (task: WorkflowTask): boolean => {
        if (!resolved.parallelWorkers) return false
        if (task.kind === "edit") return false
        if (task.dependsOn && task.dependsOn.length > 0) return false
        return true
      }

      const parallelPool = bounded.filter(canRunParallel)
      const serialPool = bounded.filter((task) => !canRunParallel(task))

      const runOne = async (task: WorkflowTask): Promise<void> => {
        if (input.abort?.aborted) throw new WorkflowAbortedError()
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
        }, liveSessions)
        taskResults.set(task.id, {
          status: inferStatusFromText(result.text),
          summary: result.text || "Worker returned no text.",
          sessionID: session.sessionID,
        })
      }

      if (parallelPool.length > 0) {
        // allSettled, not all: Promise.all rejects the instant one worker is
        // cancelled, while its siblings are still mid-flight and have not yet
        // registered themselves in liveSessions - so the teardown below would
        // snapshot an incomplete set and leave those turns running server-side.
        const settled = await Promise.allSettled(parallelPool.map(runOne))
        const reasons = settled
          .filter((entry) => entry.status === "rejected")
          .map((entry) => (entry as PromiseRejectedResult).reason)
        // Cancellation outranks any other reason. Picking the FIRST rejection in
        // array order instead let an unrelated failure (a worker whose session
        // could not even be created) mask the cancellation, so a run the user
        // stopped was reported as a crash - and, because that reason is rethrown
        // rather than absorbed, the round bypassed the teardown entirely and
        // left the cancelled child's turn running server-side.
        if (reasons.length > 0) {
          throw reasons.find((reason) => reason instanceof WorkflowAbortedError) ?? reasons[0]
        }
      }
      for (const task of serialPool) {
        await runOne(task)
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
      }, liveSessions)
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
      seedTasks = normalizeReviewerFollowUps(review.followUps, resolved)

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
  } catch (error) {
    if (!(error instanceof WorkflowAbortedError)) throw error
  } finally {
    // `finally`, not straight-line code after the catch: a genuine error is
    // rethrown above, and anything placed after the catch is skipped on that
    // path - which stranded live children exactly when a round blew up. Every
    // exit path has to stop them, or they keep spending after the run is over.
    if (input.abort?.aborted) lastStatus = "aborted"
    await stopLiveSessions()
  }

  return {
    goal: input.goal,
    mode: resolved.mode,
    status: lastStatus,
    stoppedSessionIDs,
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
  live: Set<string>,
): Promise<{ text: string; error?: string }> {
  // Registered before the call and deliberately left registered when the call
  // REJECTS: cancelling a prompt only tears down the local HTTP request, so the
  // call that never returned is exactly the one whose turn may still be running
  // on the server and still needs POST /session/{id}/abort.
  live.add(session.sessionID)
  try {
    const result = await runner.runChildSession({
      sessionID: session.sessionID,
      agent: input.agent,
      model: input.model,
      prompt: input.prompt,
      abort: input.abort,
    })
    live.delete(session.sessionID)
    return result
  } catch (error) {
    // A cancelled run has to stop here. Swallowing this recorded the worker as
    // "returned no text" and then spent a whole fresh reviewer session on that
    // empty report - after the user had already cancelled.
    if (input.abort?.aborted) throw new WorkflowAbortedError()
    live.delete(session.sessionID)
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

function truncate(value: string, max: number): string {
  if (value.length <= max) return value
  return value.slice(0, max - 1) + "\u2026"
}
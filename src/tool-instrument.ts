import type { SessionRunner } from "./runtime/types.js"
import { errorMessage } from "./util/error.js"
import type { WorkflowProgress } from "./progress.js"

/**
 * Wraps a SessionRunner so every createChildSession / runChildSession call
 * drives a WorkflowProgress sink: phase transitions, agent start and end,
 * and a one-line tail of each child's final text into the log. The wrapper
 * is the single hook both `dynamic_workflow` and the `workflow` script tool
 * share; keeping it separate makes it unit-testable without standing up the
 * full tool execute() plumbing.
 */
export function instrumentRunner(runner: SessionRunner, progress: WorkflowProgress): SessionRunner {
  let nextID = 0
  const active = new Map<string, { id: number; label: string; phase?: string }>()
  return {
    async createChildSession(input) {
      const session = await runner.createChildSession(input)
      // Prefer the explicit phase on the call (set by the script engine);
      // fall back to inferring from the dynamic_workflow title pattern.
      const phase = input.phase?.trim() || phaseFromTitle(input.title)
      progress.phase(phase)
      nextID += 1
      const info = { id: nextID, label: input.title, phase }
      active.set(session.sessionID, info)
      progress.agentStart(info)
      return session
    },
    async runChildSession(input) {
      try {
        const result = await runner.runChildSession(input)
        const info = active.get(input.sessionID)
        if (info) {
          progress.agentEnd({ ...info, ok: !result.error })
          logChildTail(progress, info, result)
        }
        return result
      } catch (error) {
        const info = active.get(input.sessionID)
        if (info) {
          progress.agentEnd({ ...info, ok: false })
          progress.log(`${info.label}: error - ${errorMessage(error)}`)
        }
        throw error
      }
    },
    deleteSession: (sessionID) => runner.deleteSession(sessionID),
  }
}

/**
 * Push a one-line tail of a child's final text into the progress log so the
 * user sees what each agent actually did without clicking into the tool part
 * or jumping into the child session. Skips empty returns (planners emit
 * structured JSON, not free-text), strips leading whitespace and quotation,
 * and caps length so a single chatty worker can't push every older log out.
 */
const LOG_TAIL_MAX = 160
function logChildTail(
  progress: WorkflowProgress,
  info: { id: number; label: string; phase?: string },
  result: { text: string; error?: string },
): void {
  if (result.error) {
    progress.log(`${info.label}: ${result.error}`)
    return
  }
  const text = result.text.trim()
  if (!text) return
  const oneLine = text.replace(/\s+/g, " ")
  const truncated = oneLine.length > LOG_TAIL_MAX
    ? `${oneLine.slice(0, LOG_TAIL_MAX - 1)}\u2026`
    : oneLine
  progress.log(`${info.label}: ${truncated}`)
}

function phaseFromTitle(title: string): string {
  if (title.startsWith("Workflow planner")) return "Plan"
  if (title.startsWith("Workflow reviewer")) return "Review"
  return "Work"
}

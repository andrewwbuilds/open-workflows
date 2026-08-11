import { describe, expect, it } from "vitest"
import { runWorkflow } from "../src/orchestrator.js"
import { resolveOptions } from "../src/options.js"
import { formatWorkflowResult } from "../src/format.js"
import { runWorkflowScript, WorkflowScriptError } from "../src/script/engine.js"
import { instrumentRunner } from "../src/tool-instrument.js"
import { WorkflowProgress } from "../src/progress.js"
import type { SessionRunner } from "../src/runtime/types.js"

/**
 * The existing "aborts cleanly when the abort signal fires" test cancels BEFORE
 * runWorkflow is called, so it only ever exercises the top-of-round guard. The
 * real case - the user cancels while a worker's turn is in flight - was never
 * covered, and that is the case that failed.
 *
 * Modelled on opencode 1.15.10, verified live:
 *  - cancelling the caller's signal rejects the prompt fetch,
 *  - but the child's turn keeps running server-side and commits its tokens,
 *  - and there is no native parent -> child abort cascade,
 *  - so only abortSession() (POST /session/{id}/abort) actually stops it.
 */
function cancellingRunner(controller: AbortController) {
  const aborted: string[] = []
  const prompts: string[] = []
  let counter = 0
  const runner: SessionRunner = {
    async createChildSession() {
      counter += 1
      return { sessionID: `s-${counter}` }
    },
    async runChildSession(input) {
      prompts.push(input.prompt)
      if (input.prompt.includes("You are the planner")) {
        return {
          text: JSON.stringify({
            rationale: "one task",
            plan: [{ id: "t1", kind: "research", title: "slow", description: "do the slow thing" }],
          }),
          sessionID: input.sessionID,
        }
      }
      if (input.prompt.includes("You are a worker")) {
        controller.abort()
        throw new Error("The operation was aborted")
      }
      return {
        text: JSON.stringify({
          summary: "looks fine",
          status: "pass",
          followUps: [],
          criteriaMet: [],
          criteriaMissed: [],
        }),
        sessionID: input.sessionID,
      }
    },
    async deleteSession() {},
    async abortSession(sessionID) {
      aborted.push(sessionID)
    },
  }
  return { runner, aborted, prompts }
}

describe("dynamic_workflow cancellation", () => {
  it("stops the in-flight child server-side instead of letting it run on", async () => {
    const controller = new AbortController()
    const { runner, aborted } = cancellingRunner(controller)
    const result = await runWorkflow({
      goal: "cancel me",
      parentSessionID: "parent",
      runner,
      abort: controller.signal,
      options: resolveOptions({ maxRounds: 3, maxWorkers: 1 }),
    })
    expect(aborted).toEqual(["s-2"])
    expect(result.stoppedSessionIDs).toEqual(["s-2"])
  })

  it("does not spend a reviewer session on work the user already cancelled", async () => {
    const controller = new AbortController()
    const { runner, prompts } = cancellingRunner(controller)
    await runWorkflow({
      goal: "cancel me",
      parentSessionID: "parent",
      runner,
      abort: controller.signal,
      options: resolveOptions({ maxRounds: 3, maxWorkers: 1 }),
    })
    expect(prompts.some((prompt) => prompt.includes("You are the reviewer"))).toBe(false)
  })

  it("reports the run as cancelled rather than completed", async () => {
    const controller = new AbortController()
    const { runner } = cancellingRunner(controller)
    const result = await runWorkflow({
      goal: "cancel me",
      parentSessionID: "parent",
      runner,
      abort: controller.signal,
      options: resolveOptions({ maxRounds: 3, maxWorkers: 1 }),
    })
    expect(result.status).toBe("aborted")
    const text = formatWorkflowResult(result)
    expect(text).toContain("Cancelled by the user")
    expect(text).toContain("Stopped 1 in-flight child session(s)")
    expect(text).not.toContain("Workflow status: completed")
  })

  it("stops every worker of a cancelled parallel round, not just the first to reject", async () => {
    const controller = new AbortController()
    const aborted: string[] = []
    const live = new Set<string>()
    let counter = 0
    const runner: SessionRunner = {
      async createChildSession() {
        counter += 1
        return { sessionID: `s-${counter}` }
      },
      async runChildSession(input) {
        if (input.prompt.includes("You are the planner")) {
          return {
            text: JSON.stringify({
              rationale: "three tasks",
              plan: [1, 2, 3].map((n) => ({
                id: `t${n}`,
                kind: "research",
                title: `task ${n}`,
                description: `do thing ${n}`,
              })),
            }),
            sessionID: input.sessionID,
          }
        }
        if (input.prompt.includes("You are a worker")) {
          live.add(input.sessionID)
          // The first worker to notice cancellation rejects immediately; the
          // others are still mid-flight, which is exactly the window in which
          // Promise.all would have torn down without them.
          if (live.size === 1) controller.abort()
          await new Promise((resolve) => setTimeout(resolve, live.size * 5))
          throw new Error("The operation was aborted")
        }
        return { text: "{}", sessionID: input.sessionID }
      },
      async deleteSession() {},
      async abortSession(sessionID) {
        aborted.push(sessionID)
      },
    }
    const result = await runWorkflow({
      goal: "cancel me",
      parentSessionID: "parent",
      runner,
      abort: controller.signal,
      options: resolveOptions({ maxRounds: 1, maxWorkers: 3, parallelWorkers: true }),
    })
    expect(result.status).toBe("aborted")
    expect(aborted.sort()).toEqual(["s-2", "s-3", "s-4"])
  })

  /**
   * A cancelled parallel round where one worker ALSO fails for an unrelated
   * reason - here its child session cannot be created at all, which is what a
   * server hiccup mid-round looks like.
   *
   * The rejections are collected by Promise.allSettled in ARRAY order, not
   * completion order, so the unrelated failure sits ahead of the cancellation.
   * Taking the first one reported a run the user deliberately stopped as a
   * crash AND, because an unrecognised reason is rethrown rather than absorbed,
   * skipped the teardown - leaving the cancelled worker's turn running
   * server-side, which is the exact bug this whole change exists to fix.
   */
  it("lets cancellation outrank an unrelated worker failure in the same round", async () => {
    const controller = new AbortController()
    const aborted: string[] = []
    let counter = 0
    const runner: SessionRunner = {
      async createChildSession(input) {
        // "task 1" is ordered ahead of "task 2" in the pool, so its rejection is
        // the one a first-rejection-wins policy picks up.
        if (input.title.includes("task 1")) throw new Error("session store unavailable")
        counter += 1
        return { sessionID: `s-${counter}` }
      },
      async runChildSession(input) {
        if (input.prompt.includes("You are the planner")) {
          return {
            text: JSON.stringify({
              rationale: "two tasks",
              plan: [1, 2].map((n) => ({
                id: `t${n}`,
                kind: "research",
                title: `task ${n}`,
                description: `do thing ${n}`,
              })),
            }),
            sessionID: input.sessionID,
          }
        }
        if (input.prompt.includes("You are a worker")) {
          controller.abort()
          throw new Error("The operation was aborted")
        }
        return { text: "{}", sessionID: input.sessionID }
      },
      async deleteSession() {},
      async abortSession(sessionID) {
        aborted.push(sessionID)
      },
    }
    const result = await runWorkflow({
      goal: "cancel me",
      parentSessionID: "parent",
      runner,
      abort: controller.signal,
      options: resolveOptions({ maxRounds: 1, maxWorkers: 2, parallelWorkers: true }),
    })
    // Reported as the cancellation it was, not as the session-store error.
    expect(result.status).toBe("aborted")
    // And the surviving worker's turn was actually stopped rather than stranded.
    expect(aborted).toEqual(["s-2"])
    expect(result.stoppedSessionIDs).toEqual(["s-2"])
  })
})

describe("workflow script cancellation", () => {
  it("reports the stopped child sessions on the partial result", async () => {
    const controller = new AbortController()
    const aborted: string[] = []
    const runner: SessionRunner = {
      async createChildSession() {
        return { sessionID: "child-1" }
      },
      async runChildSession() {
        controller.abort()
        throw new Error("The operation was aborted")
      },
      async deleteSession() {},
      async abortSession(sessionID) {
        aborted.push(sessionID)
      },
    }
    const failure = await runWorkflowScript({
      script:
        "export const meta = { name: 'c', description: 'd' }\nreturn await agent('go')",
      runner,
      abort: controller.signal,
      defaultAgent: "general",
    }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(WorkflowScriptError)
    expect(aborted).toEqual(["child-1"])
    expect((failure as WorkflowScriptError).partial.stoppedSessions).toEqual(["child-1"])
  })
})

describe("instrumentRunner capability forwarding", () => {
  it("forwards abortSession, so a cancelled dynamic_workflow really stops its children", async () => {
    const aborted: string[] = []
    const base: SessionRunner = {
      async createChildSession() {
        return { sessionID: "s-1" }
      },
      async runChildSession(input) {
        return { text: "", sessionID: input.sessionID }
      },
      async deleteSession() {},
      async abortSession(sessionID) {
        aborted.push(sessionID)
      },
    }
    const wrapped = instrumentRunner(base, new WorkflowProgress({ name: "n", sink: () => {} }))
    await wrapped.abortSession?.("s-1")
    expect(aborted).toEqual(["s-1"])
  })

  it("forwards every optional capability the wrapped runner implements", () => {
    const base: SessionRunner = {
      async createChildSession() {
        return { sessionID: "s-1" }
      },
      async runChildSession(input) {
        return { text: "", sessionID: input.sessionID }
      },
      async deleteSession() {},
      async abortSession() {},
      async resolveParentModel() {
        return "p/m"
      },
      async listModelVariants() {
        return ["low"]
      },
      async listAgents() {
        return ["general"]
      },
      async readTurnOutputTokens() {
        return 7
      },
    }
    const wrapped = instrumentRunner(base, new WorkflowProgress({ name: "n", sink: () => {} }))
    // Guards the whole class of bug: an optional method added to SessionRunner
    // and not forwarded here disappears silently, because it is optional.
    const optional = Object.keys(base).filter(
      (key) => !["createChildSession", "runChildSession", "deleteSession"].includes(key),
    )
    for (const key of optional) {
      expect(wrapped[key as keyof SessionRunner], `instrumentRunner drops ${key}`).toBeTypeOf("function")
    }
  })

  it("leaves an unsupported capability undefined so callers can feature-detect", () => {
    const bare: SessionRunner = {
      async createChildSession() {
        return { sessionID: "s-1" }
      },
      async runChildSession(input) {
        return { text: "", sessionID: input.sessionID }
      },
      async deleteSession() {},
    }
    const wrapped = instrumentRunner(bare, new WorkflowProgress({ name: "n", sink: () => {} }))
    expect(wrapped.abortSession).toBeUndefined()
    expect(wrapped.listAgents).toBeUndefined()
  })
})

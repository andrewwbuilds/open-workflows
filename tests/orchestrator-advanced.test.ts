import { describe, expect, it } from "vitest"
import { runWorkflow } from "../src/orchestrator.js"
import { createFakeRunner } from "../src/runtime/fake.js"
import { resolveOptions } from "../src/options.js"

function plannerResponse(plan: Array<{ id: string; title: string; description: string; kind?: string; dependsOn?: string[] }>): string {
  return JSON.stringify({
    plan: plan.map((task) => ({
      id: task.id,
      title: task.title,
      description: task.description,
      kind: task.kind ?? "research",
      dependsOn: task.dependsOn ?? [],
      acceptance: [],
    })),
    rationale: "test plan",
  })
}

function reviewerResponse(
  status: "pass" | "needs-attention" | "blocked" = "pass",
  summary = "ok",
  followUps: Array<{ id: string; title: string; description: string; kind?: string }> = [],
): string {
  return JSON.stringify({
    status,
    summary,
    followUps: followUps.map((task) => ({
      id: task.id,
      title: task.title,
      description: task.description,
      kind: task.kind ?? "research",
      dependsOn: [],
      acceptance: [],
    })),
    criteriaMet: [],
    criteriaMissed: status === "pass" ? [] : ["criterion"],
  })
}

function workerResponse(summary = "done"): string {
  return JSON.stringify({ status: "completed", summary })
}

describe("runWorkflow (serial edits)", () => {
  it("runs edit tasks serially even when parallelWorkers is true", async () => {
    const runner = createFakeRunner({ defaultResponse: workerResponse() })
    let next = 0
    let activeWorkers = 0
    let maxConcurrent = 0
    const orig = runner.runChildSession.bind(runner)
    runner.runChildSession = (async (input) => {
      activeWorkers += 1
      maxConcurrent = Math.max(maxConcurrent, activeWorkers)
      const r = await orig(input)
      const text = next % 4 === 0
        ? plannerResponse([
            { id: "e1", title: "Edit A", description: "Edit file A", kind: "edit" },
            { id: "e2", title: "Edit B", description: "Edit file B", kind: "edit" },
          ])
        : next % 4 === 1
          ? workerResponse("edited A")
          : next % 4 === 2
            ? workerResponse("edited B")
            : reviewerResponse("pass", "good")
      next += 1
      activeWorkers -= 1
      return { ...r, text }
    }) as typeof runner.runChildSession

    const result = await runWorkflow({
      goal: "Edit two files.",
      parentSessionID: "parent",
      runner,
      options: resolveOptions({ allowEdits: true, maxRounds: 1, maxWorkers: 4 }),
    })

    expect(result.status).toBe("completed")
    expect(maxConcurrent).toBe(1)
  })

  it("runs read-only tasks in parallel up to maxWorkers", async () => {
    const runner = createFakeRunner({ defaultResponse: workerResponse() })
    let next = 0
    let active = 0
    let peak = 0
    const orig = runner.runChildSession.bind(runner)
    runner.runChildSession = (async (input) => {
      active += 1
      peak = Math.max(peak, active)
      const r = await orig(input)
      const text = next === 0
        ? plannerResponse([
            { id: "r1", title: "Research A", description: "Look at A", kind: "research" },
            { id: "r2", title: "Research B", description: "Look at B", kind: "research" },
            { id: "r3", title: "Research C", description: "Look at C", kind: "research" },
          ])
        : next < 4
          ? workerResponse()
          : reviewerResponse("pass", "ok")
      next += 1
      active -= 1
      return { ...r, text }
    }) as typeof runner.runChildSession

    const result = await runWorkflow({
      goal: "Research three areas.",
      parentSessionID: "parent",
      runner,
      options: resolveOptions({ maxRounds: 1, maxWorkers: 4, parallelWorkers: true }),
    })

    expect(result.status).toBe("completed")
    expect(peak).toBeGreaterThan(1)
  })

  it("seeds the next round with reviewer follow-ups", async () => {
    const runner = createFakeRunner({ defaultResponse: workerResponse() })
    let next = 0
    const plannerCalls: string[] = []
    const orig = runner.runChildSession.bind(runner)
    runner.runChildSession = (async (input) => {
      const r = await orig(input)
      const phase = next % 4
      let text = ""
      if (phase === 0) {
        text = plannerResponse([
          { id: "t1", title: "Inspect", description: "Look at the code." },
        ])
      } else if (phase === 1) {
        text = workerResponse("looked")
      } else if (phase === 2) {
        text = reviewerResponse("needs-attention", "still work to do", [
          { id: "fix-1", title: "Fix the bug", description: "Repair the regression." },
        ])
      } else {
        text = plannerResponse([
          { id: "fix-1", title: "Fix the bug", description: "Repair the regression." },
        ])
      }
      next += 1
      if (phase === 0 || phase === 3) plannerCalls.push(text)
      return { ...r, text }
    }) as typeof runner.runChildSession

    const result = await runWorkflow({
      goal: "Ship a fix.",
      parentSessionID: "parent",
      runner,
      options: resolveOptions({ allowEdits: true, maxRounds: 2, maxWorkers: 1 }),
    })

    expect(result.rounds).toHaveLength(2)
    expect(result.rounds[1]?.tasks[0]?.id).toBe("fix-1")
  })

  it("returns a formatted error when the tool throws", async () => {
    const { formatError } = await import("../src/format.js")
    const out = formatError("dynamic_workflow failed", new Error("agent not found"), {
      goal: "test",
      mode: "research",
    })
    expect(out).toContain("agent not found")
    expect(out).toContain("Goal: test")
  })

  it("aborts cleanly when the abort signal fires", async () => {
    const controller = new AbortController()
    controller.abort()
    const runner = createFakeRunner({ defaultResponse: workerResponse() })
    const result = await runWorkflow({
      goal: "Anything.",
      parentSessionID: "parent",
      runner,
      abort: controller.signal,
      options: resolveOptions({ maxRounds: 3, maxWorkers: 1 }),
    })
    expect(result.status).toBe("aborted")
    expect(result.rounds).toHaveLength(0)
  })
})
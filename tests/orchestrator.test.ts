import { describe, expect, it } from "vitest"
import { runWorkflow } from "../src/orchestrator.js"
import { createFakeRunner } from "../src/runtime/fake.js"
import { resolveOptions } from "../src/options.js"

function plannerResponse(plan: Array<{ id: string; title: string; description: string; kind?: string }>): string {
  return JSON.stringify({
    plan: plan.map((task) => ({
      id: task.id,
      title: task.title,
      description: task.description,
      kind: task.kind ?? "research",
      dependsOn: [],
      acceptance: [],
    })),
    rationale: "test plan",
  })
}

function reviewerResponse(status: "pass" | "needs-attention" | "blocked" = "pass", summary = "ok"): string {
  return JSON.stringify({
    status,
    summary,
    followUps: [],
    criteriaMet: [],
    criteriaMissed: [],
  })
}

function workerResponse(status: "completed" | "needs-attention" | "blocked" = "completed", summary = "done"): string {
  return JSON.stringify({ status, summary })
}

describe("runWorkflow", () => {
  it("runs a single round and passes", async () => {
    const runner = createFakeRunner({
      defaultResponse: workerResponse(),
    })
    const planText = plannerResponse([
      { id: "t1", title: "Inspect auth", description: "Look at the auth flow." },
    ])
    // First run: planner. Second run: worker. Third run: reviewer.
    let next = 0
    const orig = runner.runChildSession.bind(runner)
    runner.runChildSession = (async (input) => {
      const r = await orig(input)
      const plan = next === 0 ? planText : next === 1 ? workerResponse() : reviewerResponse("pass", "looks good")
      next += 1
      return { ...r, text: plan }
    }) as typeof runner.runChildSession

    const result = await runWorkflow({
      goal: "Audit auth flow.",
      parentSessionID: "parent",
      runner,
      options: resolveOptions({ maxRounds: 2, maxWorkers: 2 }),
    })

    expect(result.status).toBe("completed")
    expect(result.rounds).toHaveLength(1)
    expect(result.rounds[0]?.tasks[0]?.status).toBe("completed")
  })

  it("rejects edit tasks when edits are disabled", async () => {
    const runner = createFakeRunner({
      defaultResponse: workerResponse(),
    })
    let next = 0
    const planText = plannerResponse([
      { id: "t1", title: "Edit file", description: "Modify foo.ts.", kind: "edit" },
    ])
    const reviewText = reviewerResponse("pass", "ok")
    const orig = runner.runChildSession.bind(runner)
    runner.runChildSession = (async (input) => {
      const r = await orig(input)
      const text = next === 0 ? planText : next === 1 ? workerResponse() : reviewText
      next += 1
      return { ...r, text }
    }) as typeof runner.runChildSession

    const result = await runWorkflow({
      goal: "Implement change.",
      parentSessionID: "parent",
      runner,
      options: resolveOptions({ allowEdits: false, maxRounds: 1, maxWorkers: 1 }),
    })

    expect(result.rounds[0]?.tasks).toHaveLength(0)
  })

  it("marks budget exhausted when reviewer keeps requesting follow-ups", async () => {
    const runner = createFakeRunner({
      defaultResponse: workerResponse(),
    })
    let next = 0
    const planText = plannerResponse([
      { id: "t1", title: "Inspect", description: "Inspect the worktree." },
    ])
    const reviewText = reviewerResponse("needs-attention", "more work")
    const orig = runner.runChildSession.bind(runner)
    runner.runChildSession = (async (input) => {
      const r = await orig(input)
      const text = next % 3 === 0 ? planText : next % 3 === 1 ? workerResponse() : reviewText
      next += 1
      return { ...r, text }
    }) as typeof runner.runChildSession

    const result = await runWorkflow({
      goal: "Iterate.",
      parentSessionID: "parent",
      runner,
      options: resolveOptions({ maxRounds: 2, maxWorkers: 1 }),
    })

    expect(result.status).toBe("budget-exhausted")
    expect(result.rounds).toHaveLength(2)
  })
})

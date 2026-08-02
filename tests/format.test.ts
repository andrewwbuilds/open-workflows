import { describe, expect, it } from "vitest"
import { formatWorkflowResult } from "../src/format.js"
import type { WorkflowResult } from "../src/types.js"

const baseResult: WorkflowResult = {
  goal: "Audit auth",
  mode: "research",
  status: "completed",
  rounds: [
    {
      round: 1,
      plannerSessionID: "p1",
      workerSessionIDs: ["w1", "w2"],
      reviewerSessionID: "r1",
      tasks: [
        {
          id: "t1",
          title: "Inspect",
          description: "",
          kind: "research",
          status: "completed",
          sessionID: "w1",
          summary: "All good",
        },
      ],
      review: {
        status: "pass",
        summary: "no findings",
        followUps: [],
        criteriaMet: [],
        criteriaMissed: [],
      },
    },
  ],
  finalSummary: "Done.",
  artifacts: { plannerSessionID: "p1", workerSessionIDs: ["w1", "w2"], reviewerSessionIDs: ["r1"] },
}

describe("formatWorkflowResult", () => {
  it("includes status, mode, sessions, and review summary", () => {
    const text = formatWorkflowResult(baseResult)
    expect(text).toContain("Workflow status: completed")
    expect(text).toContain("Mode: research")
    expect(text).toContain("planner: p1")
    expect(text).toContain("worker:  w1")
    expect(text).toContain("reviewer: r1")
    expect(text).toContain("no findings")
  })

  it("truncates overly long output", () => {
    const text = formatWorkflowResult(baseResult, { maxChars: 80 })
    expect(text.endsWith("(truncated)")).toBe(true)
  })
})

import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { runWorkflow } from "../src/orchestrator.js"
import { createFakeRunner } from "../src/runtime/fake.js"
import { resolveOptions } from "../src/options.js"
import { formatWorkflowResult } from "../src/format.js"

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
    rationale: "self-audit",
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

function workerResponse(summary: string): string {
  return JSON.stringify({ status: "completed", summary })
}

describe("recursive self-debug simulation", () => {
  it("runs a multi-round audit-and-fix loop with realistic model behavior", async () => {
    const sourceFiles = [
      "src/orchestrator.ts",
      "src/tool.ts",
      "src/runtime/sdk.ts",
      "src/prompts.ts",
      "src/util/normalize.ts",
      "src/util/parse.ts",
      "src/options.ts",
      "src/format.ts",
      "src/types.ts",
    ]
    let next = 0
    let reviewed = false

    const runner = createFakeRunner({ defaultResponse: workerResponse("nothing") })
    const orig = runner.runChildSession.bind(runner)
    runner.runChildSession = (async (input) => {
      const r = await orig(input)
      const phase = next % 4
      let text = ""
      if (phase === 0) {
        const fileList = sourceFiles.slice(0, 2 + (next / 4)).join(", ")
        text = plannerResponse([
          { id: "audit-1", title: "Audit code", description: `Look for bugs in ${fileList}.` },
          { id: "fix-1", title: "Fix issues", description: "Apply minimal patches.", kind: "edit" },
        ])
      } else if (phase === 1) {
        text = workerResponse("audited, found nothing")
      } else if (phase === 2) {
        text = workerResponse("fixed")
        reviewed = true
      } else {
        text = reviewerResponse(reviewed ? "pass" : "needs-attention", reviewed ? "all good" : "keep iterating")
      }
      next += 1
      return { ...r, text }
    }) as typeof runner.runChildSession

    const result = await runWorkflow({
      goal: "Audit and fix open-workflows.",
      parentSessionID: "parent",
      runner,
      options: resolveOptions({ allowEdits: true, maxRounds: 3, maxWorkers: 2 }),
    })

    const text = formatWorkflowResult(result)
    expect(text).toContain("Workflow status:")
    expect(text).toContain("Final:")
    expect(result.rounds.length).toBeGreaterThan(0)
  })

  it("command template can be loaded and parses $ARGUMENTS", () => {
    const template = readFileSync(resolve("commands/workflow.md"), "utf8")
    const body = template.replace(/^---[\s\S]+?---\n/, "")
    expect(body).toContain("$ARGUMENTS")
    const rendered = body.replace("$ARGUMENTS", "audit the auth flow")
    expect(rendered).not.toContain("$ARGUMENTS")
    expect(rendered).toContain("audit the auth flow")
  })
})
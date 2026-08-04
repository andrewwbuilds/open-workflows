import { describe, expect, it } from "vitest"
import { runWorkflowScript, WorkflowScriptError } from "../src/script/engine.js"
import { hashAgentCall } from "../src/script/journal.js"
import { parseWorkflowScript } from "../src/script/meta.js"
import { validateAgainstSchema } from "../src/script/schema.js"
import { WorkflowProgress, type ProgressUpdate } from "../src/progress.js"
import { createSdkRunner } from "../src/runtime/sdk.js"
import type { RunChildSessionInput, SessionRunner } from "../src/runtime/types.js"

function withMeta(body: string): string {
  return `export const meta = { name: 'regress', description: 'regression tests' }\n${body}`
}

describe("cancellation is not swallowed by parallel/pipeline", () => {
  function abortingRunner(controller: AbortController): SessionRunner & { runs: RunChildSessionInput[] } {
    const runs: RunChildSessionInput[] = []
    let counter = 0
    return {
      runs,
      async createChildSession() {
        counter += 1
        return { sessionID: `s-${counter}` }
      },
      async runChildSession(input) {
        runs.push(input)
        // First call cancels the workflow mid-flight, then fails like an
        // interrupted network request would.
        controller.abort()
        throw new Error("request aborted")
      },
      async deleteSession() {},
    }
  }

  it("parallel(): a cancel mid-fan-out rejects the workflow instead of completing", async () => {
    const controller = new AbortController()
    const runner = abortingRunner(controller)
    let reachedPastBarrier = false
    const failure = await runWorkflowScript({
      script: withMeta(
        [
          "const out = await parallel([() => agent('a'), () => agent('b')])",
          "args.mark()",
          "return out",
        ].join("\n"),
      ),
      args: { mark: () => { reachedPastBarrier = true } },
      runner,
      abort: controller.signal,
      defaultAgent: "general",
    }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(WorkflowScriptError)
    expect((failure as Error).message).toMatch(/aborted/i)
    expect(reachedPastBarrier).toBe(false)
  })

  it("pipeline(): a cancel mid-stage rejects the workflow instead of returning nulls", async () => {
    const controller = new AbortController()
    const runner = abortingRunner(controller)
    const failure = await runWorkflowScript({
      script: withMeta("return pipeline(['x', 'y'], (item) => agent('analyze ' + item))"),
      runner,
      abort: controller.signal,
      defaultAgent: "general",
    }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(WorkflowScriptError)
    expect((failure as Error).message).toMatch(/aborted/i)
  })
})

describe("budget is re-checked when queued agents get a slot", () => {
  it("stops a concurrent fan-out once the ceiling is crossed", async () => {
    const runs: RunChildSessionInput[] = []
    let counter = 0
    const runner: SessionRunner = {
      async createChildSession() {
        counter += 1
        return { sessionID: `s-${counter}` }
      },
      async runChildSession(input) {
        runs.push(input)
        return { text: "ok", sessionID: input.sessionID, tokens: { output: 60 } }
      },
      async deleteSession() {},
    }
    const result = await runWorkflowScript({
      script: withMeta(
        "return parallel([() => agent('a'), () => agent('b'), () => agent('c')])",
      ),
      runner,
      defaultAgent: "general",
      concurrency: 1,
      budgetTokens: 50,
    })
    // Only the first agent runs; the queued ones see the exhausted budget
    // when they acquire their slot and resolve to null.
    expect(runs).toHaveLength(1)
    expect(result.value).toEqual(["ok", null, null])
  })
})

describe("a script failure cancels in-flight agents", () => {
  it("aborts the signal handed to the runner", async () => {
    let observed: AbortSignal | undefined
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const runner: SessionRunner = {
      async createChildSession() {
        return { sessionID: "s-1" }
      },
      async runChildSession(input) {
        observed = input.abort
        release?.()
        await new Promise((resolve) => setTimeout(resolve, 30))
        return { text: "ok", sessionID: input.sessionID }
      },
      async deleteSession() {},
    }
    const failure = runWorkflowScript({
      script: withMeta(
        [
          "const pending = agent('slow one')",
          "await args.started",
          "throw new Error('script exploded')",
        ].join("\n"),
      ),
      args: { started: gate },
      runner,
      defaultAgent: "general",
    }).catch((error: unknown) => error)
    expect(await failure).toBeInstanceOf(WorkflowScriptError)
    expect(observed?.aborted).toBe(true)
  })
})

describe("schema integer validation", () => {
  it("rejects fractional numbers for integer fields", () => {
    expect(validateAgainstSchema(2.7, { type: "integer" }, "$")).toMatch(/must be integer/)
    expect(validateAgainstSchema(3, { type: "integer" }, "$")).toBeUndefined()
  })
})

describe("meta detection skips comments and strings", () => {
  it("parses the real meta when a comment quotes the convention", () => {
    const script = [
      "// Every workflow starts with: export const meta = { name, description }",
      "export const meta = { name: 'triage', description: 'real meta' }",
      "return 1",
    ].join("\n")
    const { meta, body } = parseWorkflowScript(script)
    expect(meta.name).toBe("triage")
    expect(body).toContain("Every workflow starts with")
    expect(body).toContain("return 1")
  })

  it("ignores the convention quoted inside a string literal", () => {
    const script = [
      "export const meta = { name: 'real', description: 'x' }",
      "const doc = 'export const meta = fake'",
      "return doc",
    ].join("\n")
    expect(parseWorkflowScript(script).meta.name).toBe("real")
  })
})

describe("progress phase lifecycle", () => {
  it("marks a drained phase done even when it drains after a later phase started", () => {
    const updates: ProgressUpdate[] = []
    const progress = new WorkflowProgress({
      name: "t",
      plannedPhases: ["A", "B"],
      throttleMs: 0,
      sink: (update) => updates.push(update),
    })
    progress.phase("A")
    progress.agentStart({ id: 1, label: "slow", phase: "A" })
    progress.phase("B")
    progress.agentEnd({ id: 1, label: "slow", phase: "A", ok: true })
    const roadmap = (updates[updates.length - 1]?.metadata?.roadmap as string) ?? ""
    expect(roadmap).toContain("[x] A - 1 done")
    expect(roadmap).toContain("[>] B")
    expect(updates[updates.length - 1]?.title).toContain("B")
  })

  it("stops emitting after finish()", () => {
    const updates: ProgressUpdate[] = []
    const progress = new WorkflowProgress({
      name: "t",
      throttleMs: 0,
      sink: (update) => updates.push(update),
    })
    progress.phase("A")
    progress.finish("failed")
    const count = updates.length
    progress.agentEnd({ id: 9, label: "straggler", phase: "A", ok: false })
    progress.log("late")
    progress.finish("completed")
    expect(updates.length).toBe(count)
  })
})

describe("SdkRunner abort forwarding", () => {
  it("passes the abort signal to session.prompt", async () => {
    const controller = new AbortController()
    let captured: Record<string, unknown> | undefined
    const client = {
      session: {
        async create() {
          return { data: { id: "child" } }
        },
        async prompt(options: Record<string, unknown>) {
          captured = options
          return { data: { info: {}, parts: [{ type: "text", text: "hi" }] } }
        },
        async delete() {
          return { data: true }
        },
      },
    }
    const runner = createSdkRunner(client as never, "parent")
    await runner.runChildSession({
      sessionID: "child",
      agent: "general",
      prompt: "hello",
      abort: controller.signal,
    })
    expect(captured?.signal).toBe(controller.signal)
  })
})

describe("phase model inheritance from meta.phases", () => {
  it("uses the phase's declared model when the call has no override", async () => {
    const models: Array<string | undefined> = []
    let counter = 0
    const runner: SessionRunner = {
      async createChildSession(input) {
        models.push(input.model)
        counter += 1
        return { sessionID: `s-${counter}` }
      },
      async runChildSession(input) {
        return { text: "ok", sessionID: input.sessionID }
      },
      async deleteSession() {},
    }
    await runWorkflowScript({
      script: [
        "export const meta = { name: 'pm', description: 'x', phases: [",
        "  { title: 'Cheap', model: 'anthropic/claude-haiku-4-5' },",
        "  { title: 'Hard' },",
        "] }",
        "phase('Cheap')",
        "await agent('easy task')",
        "await agent('override', { model: 'anthropic/claude-opus-5' })",
        "phase('Hard')",
        "await agent('hard task')",
      ].join("\n"),
      runner,
      defaultAgent: "general",
      model: "anthropic/claude-sonnet-4-5",
    })
    expect(models).toEqual([
      "anthropic/claude-haiku-4-5",
      "anthropic/claude-opus-5",
      "anthropic/claude-sonnet-4-5",
    ])
  })
})

describe("resume hash ignores no-op option changes", () => {
  it("is insensitive to label, effort, non-worktree isolation, undefined values, and key order", () => {
    const base = hashAgentCall("do it", { phase: "A", model: "m" })
    expect(hashAgentCall("do it", { model: "m", phase: "A" })).toBe(base)
    expect(hashAgentCall("do it", { phase: "A", model: "m", label: "x" })).toBe(base)
    expect(hashAgentCall("do it", { phase: "A", model: "m", effort: "high" })).toBe(base)
    expect(hashAgentCall("do it", { phase: "A", model: "m", isolation: "remote" })).toBe(base)
    expect(hashAgentCall("do it", { phase: "A", model: "m", agentType: undefined })).toBe(base)
    expect(hashAgentCall("do it", { phase: "A", model: "m", isolation: "worktree" })).not.toBe(base)
    expect(hashAgentCall("do it", { phase: "B", model: "m" })).not.toBe(base)
    expect(hashAgentCall("other", { phase: "A", model: "m" })).not.toBe(base)
  })
})

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
  it("nulls the queued calls once the ceiling is crossed, and says so", async () => {
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
    // A queued agent that finds the ceiling crossed throws a
    // WorkflowLimitError, and parallel() degrades that to a null item like any
    // other thunk failure - Claude Code's contract. The holes are explained by
    // result.limitBreach and a single log line rather than by a rejection.
    const result = await runWorkflowScript({
      script: withMeta(
        "return parallel([() => agent('a'), () => agent('b'), () => agent('c')])",
      ),
      runner,
      defaultAgent: "general",
      concurrency: 1,
      budgetTokens: 50,
    })
    expect(result.value).toEqual(["ok", null, null])
    expect(result.limitBreach).toMatch(/Token budget exhausted: spent 60 of 50/)
    expect(result.logs.filter((line) => /Token budget exhausted/.test(line))).toHaveLength(1)
    // Only the first agent ever reached the runner.
    expect(runs).toHaveLength(1)
  })

  it("still rejects when the ceiling is crossed outside a fan-out", async () => {
    // The throw is unchanged; only parallel()/pipeline() degrade it.
    const runner: SessionRunner = {
      async createChildSession() {
        return { sessionID: "s-1" }
      },
      async runChildSession(input) {
        return { text: "ok", sessionID: input.sessionID, tokens: { output: 60 } }
      },
      async deleteSession() {},
    }
    await expect(
      runWorkflowScript({
        script: withMeta("await agent('a')\nawait agent('b')\nreturn 'done'"),
        runner,
        defaultAgent: "general",
        budgetTokens: 50,
      }),
    ).rejects.toThrow(/Token budget exhausted/)
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

describe("SdkRunner returns the subagent's final text, not its narration", () => {
  function runnerFor(parts: Array<Record<string, unknown>>) {
    const client = {
      session: {
        create: async () => ({ data: { id: "child" } }),
        prompt: async () => ({ data: { info: {}, parts } }),
        delete: async () => ({ data: true }),
      },
    }
    return createSdkRunner(client as never, "parent")
  }

  it("keeps only the text after the last tool call", async () => {
    // An assistant turn that used tools narrates around each call in the same
    // message; joining every text part handed the script the narration too.
    const result = await runnerFor([
      { type: "step-start" },
      { type: "text", text: "Let me check the tests..." },
      { type: "tool", tool: "bash" },
      { type: "text", text: "3 flaky tests" },
    ]).runChildSession({ sessionID: "child", agent: "general", prompt: "go" })
    expect(result.text).toBe("3 flaky tests")
  })

  it("joins every text part when the turn used no tools", async () => {
    const result = await runnerFor([
      { type: "text", text: "line one" },
      { type: "text", text: "line two" },
    ]).runChildSession({ sessionID: "child", agent: "general", prompt: "go" })
    expect(result.text).toBe("line one\nline two")
  })

  it("returns an empty string when the turn ended on a tool call", async () => {
    const result = await runnerFor([
      { type: "text", text: "working on it" },
      { type: "tool", tool: "bash" },
    ]).runChildSession({ sessionID: "child", agent: "general", prompt: "go" })
    expect(result.text).toBe("")
  })

  // Every assistant message OpenCode actually returns ends with a step-finish
  // part. The fixtures above all omit it, which let a backward scan that
  // stopped on the first non-text part ship while returning "" for literally
  // every real response.
  it("reads the answer from a real single-step message ending in step-finish", async () => {
    const result = await runnerFor([
      { type: "step-start" },
      { type: "text", text: "the answer" },
      { type: "step-finish" },
    ]).runChildSession({ sessionID: "child", agent: "general", prompt: "go" })
    expect(result.text).toBe("the answer")
  })

  it("keeps only post-tool text in a real multi-step message ending in step-finish", async () => {
    const result = await runnerFor([
      { type: "step-start" },
      { type: "text", text: "Let me check..." },
      { type: "tool", tool: "bash" },
      { type: "step-start" },
      { type: "text", text: "3 flaky tests" },
      { type: "step-finish" },
    ]).runChildSession({ sessionID: "child", agent: "general", prompt: "go" })
    expect(result.text).toBe("3 flaky tests")
  })

  it("still returns empty when a real message ends on a tool call", async () => {
    const result = await runnerFor([
      { type: "step-start" },
      { type: "text", text: "working on it" },
      { type: "tool", tool: "bash" },
      { type: "step-finish" },
    ]).runChildSession({ sessionID: "child", agent: "general", prompt: "go" })
    expect(result.text).toBe("")
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
  it("is insensitive to label, non-worktree isolation, undefined values, and key order", () => {
    const base = hashAgentCall("do it", { phase: "A", model: "m" })
    expect(hashAgentCall("do it", { model: "m", phase: "A" })).toBe(base)
    expect(hashAgentCall("do it", { phase: "A", model: "m", label: "x" })).toBe(base)
    // agent() now rejects a non-worktree isolation, so this case only keeps
    // journals written before that rejection replayable once the option is
    // deleted from the script.
    expect(hashAgentCall("do it", { phase: "A", model: "m", isolation: "remote" })).toBe(base)
    expect(hashAgentCall("do it", { phase: "A", model: "m", agentType: undefined })).toBe(base)
    expect(hashAgentCall("do it", { phase: "A", model: "m", isolation: "worktree" })).not.toBe(base)
    expect(hashAgentCall("do it", { phase: "B", model: "m" })).not.toBe(base)
    expect(hashAgentCall("other", { phase: "A", model: "m" })).not.toBe(base)
  })

  it("hashes the agentType the script wrote, not the alias it resolves to", () => {
    // Load-bearing for resume: the alias table is applied AFTER hashing, so an
    // old journal keeps replaying and a later edit to the table cannot bust it.
    const base = hashAgentCall("do it", { agentType: "Explore" })
    expect(hashAgentCall("do it", { agentType: "explore" })).not.toBe(base)
    expect(hashAgentCall("do it", { agentType: "Explore" })).toBe(base)
  })

  it("treats effort as significant: it selects the model variant", () => {
    const base = hashAgentCall("do it", { phase: "A", model: "m" })
    expect(hashAgentCall("do it", { phase: "A", model: "m", effort: "high" })).not.toBe(base)
    expect(hashAgentCall("do it", { phase: "A", model: "m", effort: "max" })).not.toBe(
      hashAgentCall("do it", { phase: "A", model: "m", effort: "high" }),
    )
  })
})

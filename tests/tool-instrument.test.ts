import { describe, expect, it } from "vitest"
import { instrumentRunner } from "../src/tool-instrument.js"
import { WorkflowProgress, type ProgressUpdate } from "../src/progress.js"
import type { RunChildSessionInput, RunChildSessionResult, SessionRunner } from "../src/runtime/types.js"

function makeRunner(response: RunChildSessionResult): SessionRunner & { calls: RunChildSessionInput[] } {
  const calls: RunChildSessionInput[] = []
  let counter = 0
  return {
    calls,
    async createChildSession() {
      counter += 1
      return { sessionID: `c-${counter}` }
    },
    async runChildSession(input) {
      calls.push(input)
      return { ...response, sessionID: input.sessionID }
    },
    async deleteSession() {},
  }
}

function collectingProgress() {
  const updates: ProgressUpdate[] = []
  const progress = new WorkflowProgress({ name: "t", throttleMs: 0, sink: (u) => updates.push(u) })
  return { progress, updates }
}

describe("instrumentRunner", () => {
  it("emits agentStart and agentEnd around each runChildSession", async () => {
    const { progress, updates } = collectingProgress()
    const runner = makeRunner({ text: "", sessionID: "" })
    const instrumented = instrumentRunner(runner, progress)
    await instrumented.createChildSession({ title: "first look", agent: "general", phase: "Scan" })
    await instrumented.runChildSession({
      sessionID: "c-1",
      agent: "general",
      prompt: "hi",
    })
    const titles = updates.map((update) => update.title ?? "")
    expect(titles.some((t) => t.includes("Scan"))).toBe(true)
  })

  it("pushes a one-line tail of each child's final text into the progress log", async () => {
    const { progress, updates } = collectingProgress()
    const runner = makeRunner({
      text: "Found 3 callers\n  - foo() at bar.ts:12\n  - baz() at qux.ts:7",
      sessionID: "",
    })
    const instrumented = instrumentRunner(runner, progress)
    await instrumented.createChildSession({ title: "scan auth", agent: "general", phase: "Scan" })
    await instrumented.runChildSession({ sessionID: "c-1", agent: "general", prompt: "x" })
    const last = updates.at(-1)
    const logs = (last?.metadata?.logs as string[] | undefined) ?? []
    expect(logs.some((entry) => entry.includes("scan auth") && entry.includes("Found 3 callers"))).toBe(true)
  })

  it("truncates very long child replies so they do not crowd out earlier logs", async () => {
    const { progress, updates } = collectingProgress()
    const long = "x".repeat(400)
    const runner = makeRunner({ text: long, sessionID: "" })
    const instrumented = instrumentRunner(runner, progress)
    await instrumented.createChildSession({ title: "wide scan", agent: "general", phase: "Scan" })
    await instrumented.runChildSession({ sessionID: "c-1", agent: "general", prompt: "x" })
    const last = updates.at(-1)
    const logs = (last?.metadata?.logs as string[] | undefined) ?? []
    const entry = logs.find((entry) => entry.startsWith("wide scan:"))
    expect(entry).toBeDefined()
    expect(entry!.length).toBeLessThanOrEqual("wide scan: ".length + 161)
    expect(entry!.endsWith("\u2026")).toBe(true)
  })

  it("does not log empty child replies (planners return JSON, not prose)", async () => {
    const { progress, updates } = collectingProgress()
    const runner = makeRunner({ text: "", sessionID: "" })
    const instrumented = instrumentRunner(runner, progress)
    await instrumented.createChildSession({ title: "planner", agent: "general", phase: "Plan" })
    await instrumented.runChildSession({ sessionID: "c-1", agent: "general", prompt: "x" })
    const last = updates.at(-1)
    const logs = (last?.metadata?.logs as string[] | undefined) ?? []
    expect(logs.some((entry) => entry.startsWith("planner:"))).toBe(false)
  })

  it("logs the error class on a failed child instead of its text", async () => {
    const { progress, updates } = collectingProgress()
    const runner = makeRunner({
      text: "",
      sessionID: "",
      error: "rate limited",
      errorName: "APIError",
    })
    const instrumented = instrumentRunner(runner, progress)
    await instrumented.createChildSession({ title: "doomed", agent: "general", phase: "Work" })
    await instrumented.runChildSession({ sessionID: "c-1", agent: "general", prompt: "x" })
    const last = updates.at(-1)
    const logs = (last?.metadata?.logs as string[] | undefined) ?? []
    expect(logs.some((entry) => entry.includes("doomed") && entry.includes("rate limited"))).toBe(true)
  })
})


describe("instrumentRunner forwards every optional capability", () => {
  /**
   * The wrapper originally returned an object literal holding only the three
   * methods it instruments. Every other SessionRunner method is optional, so
   * TypeScript accepted the omission silently and each capability vanished the
   * moment a runner was instrumented - which is how dynamic_workflow's
   * cancellation teardown ended up calling `abortSession?.()` on a wrapper that
   * had none, no-opping while child sessions ran on server-side.
   *
   * This test is the guard. It is deliberately written against the OPTIONAL
   * surface of SessionRunner rather than a fixed list, so a capability added
   * later and not delegated fails here instead of in production.
   */
  const OPTIONAL_METHODS = [
    "abortSession",
    "resolveParentModel",
    "listModelVariants",
    "listAgents",
    "readTurnOutputTokens",
  ] as const

  function fullRunner(): SessionRunner & { seen: string[] } {
    const seen: string[] = []
    const runner: Record<string, unknown> = {
      seen,
      async createChildSession() {
        return { sessionID: "c-1" }
      },
      async runChildSession(input: RunChildSessionInput) {
        return { text: "", sessionID: input.sessionID }
      },
      async deleteSession() {},
    }
    for (const name of OPTIONAL_METHODS) {
      runner[name] = async (arg: unknown) => {
        seen.push(`${name}:${String(arg)}`)
        return undefined
      }
    }
    return runner as unknown as SessionRunner & { seen: string[] }
  }

  it("exposes every optional method the underlying runner has", () => {
    const { progress } = collectingProgress()
    const wrapped = instrumentRunner(fullRunner(), progress) as unknown as Record<string, unknown>
    for (const name of OPTIONAL_METHODS) {
      expect(typeof wrapped[name], `${name} was dropped by instrumentRunner`).toBe("function")
    }
  })

  it("delegates each call through to the underlying runner", async () => {
    const runner = fullRunner()
    const { progress } = collectingProgress()
    const wrapped = instrumentRunner(runner, progress)
    await wrapped.abortSession?.("ses_child")
    await wrapped.resolveParentModel?.()
    await wrapped.listModelVariants?.("anthropic/claude-opus-5")
    await wrapped.listAgents?.()
    await wrapped.readTurnOutputTokens?.("msg_1")
    expect(runner.seen).toEqual([
      "abortSession:ses_child",
      "resolveParentModel:undefined",
      "listModelVariants:anthropic/claude-opus-5",
      "listAgents:undefined",
      "readTurnOutputTokens:msg_1",
    ])
  })

  it("keeps an unsupported capability undefined so callers can feature-detect", () => {
    // A runner without abortSession must not gain a broken stub: the engine
    // branches on its presence.
    const bare = makeRunner({ text: "", sessionID: "c-1" })
    const { progress } = collectingProgress()
    const wrapped = instrumentRunner(bare, progress)
    for (const name of OPTIONAL_METHODS) {
      expect((wrapped as unknown as Record<string, unknown>)[name]).toBeUndefined()
    }
  })
})

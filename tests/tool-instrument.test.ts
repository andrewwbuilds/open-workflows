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


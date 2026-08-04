import { describe, expect, it } from "vitest"
import { runWorkflowScript, WorkflowScriptError } from "../src/script/engine.js"
import type {
  CreateChildSessionInput,
  RunChildSessionInput,
  RunChildSessionResult,
  SessionRunner,
} from "../src/runtime/types.js"

interface ScriptedRunner extends SessionRunner {
  created: Array<CreateChildSessionInput & { sessionID: string }>
  runs: RunChildSessionInput[]
}

function scriptedRunner(
  respond: (input: RunChildSessionInput, runIndex: number) => string | Partial<RunChildSessionResult>,
): ScriptedRunner {
  const created: ScriptedRunner["created"] = []
  const runs: RunChildSessionInput[] = []
  let counter = 0
  return {
    created,
    runs,
    async createChildSession(input) {
      counter += 1
      const sessionID = `s-${counter}`
      created.push({ ...input, sessionID })
      return { sessionID }
    },
    async runChildSession(input) {
      const index = runs.length
      runs.push(input)
      const response = respond(input, index)
      const base: RunChildSessionResult = { text: "", sessionID: input.sessionID }
      if (typeof response === "string") return { ...base, text: response }
      return { ...base, ...response }
    },
    async deleteSession() {},
  }
}

function withMeta(body: string, phases?: string): string {
  const phasesLiteral = phases ? `, phases: ${phases}` : ""
  return `export const meta = { name: 'test-wf', description: 'test workflow'${phasesLiteral} }\n${body}`
}

describe("runWorkflowScript", () => {
  it("runs a script end to end: agent text, phases, logs, return value", async () => {
    const runner = scriptedRunner(() => "agent says hi")
    const result = await runWorkflowScript({
      script: withMeta(
        [
          "phase('Scan')",
          "log('starting')",
          "const text = await agent('say hi', { label: 'greeter' })",
          "return { text }",
        ].join("\n"),
        "[{ title: 'Scan' }]",
      ),
      runner,
      defaultAgent: "general",
    })
    expect(result.value).toEqual({ text: "agent says hi" })
    expect(result.phases).toEqual(["Scan"])
    expect(result.logs).toEqual(["starting"])
    expect(result.agentCount).toBe(1)
    expect(result.sessionIDs).toEqual(["s-1"])
    expect(runner.created[0]?.title).toBe("greeter")
    expect(runner.created[0]?.agent).toBe("general")
  })

  it("passes args verbatim to the script", async () => {
    const runner = scriptedRunner(() => "")
    const result = await runWorkflowScript({
      script: withMeta("return args.files.map((f) => f.toUpperCase())"),
      args: { files: ["a.ts", "b.ts"] },
      runner,
      defaultAgent: "general",
    })
    expect(result.value).toEqual(["A.TS", "B.TS"])
  })

  it("validates schema output and retries in the same session on mismatch", async () => {
    const runner = scriptedRunner((input, index) => {
      if (index === 0) return "not json at all"
      return '{"bugs": ["one"]}'
    })
    const result = await runWorkflowScript({
      script: withMeta(
        "return await agent('find bugs', { schema: { type: 'object', required: ['bugs'] } })",
      ),
      runner,
      defaultAgent: "general",
    })
    expect(result.value).toEqual({ bugs: ["one"] })
    expect(runner.runs).toHaveLength(2)
    expect(runner.runs[0]?.prompt).toContain("JSON Schema")
    expect(runner.runs[1]?.prompt).toContain("rejected")
    expect(runner.runs[1]?.sessionID).toBe(runner.runs[0]?.sessionID)
  })

  it("returns null from agent() when schema retries are exhausted", async () => {
    const runner = scriptedRunner(() => "still not json")
    const result = await runWorkflowScript({
      script: withMeta(
        "return await agent('find bugs', { schema: { type: 'object', required: ['bugs'] } })",
      ),
      runner,
      defaultAgent: "general",
      schemaRetries: 1,
    })
    expect(result.value).toBeNull()
    expect(runner.runs).toHaveLength(2)
  })

  it("returns null from agent() on a session error", async () => {
    const runner = scriptedRunner(() => ({ text: "", error: "boom" }))
    const result = await runWorkflowScript({
      script: withMeta("return await agent('do a thing')"),
      runner,
      defaultAgent: "general",
    })
    expect(result.value).toBeNull()
  })

  it("honors per-call agentType and model overrides", async () => {
    const runner = scriptedRunner(() => "ok")
    await runWorkflowScript({
      script: withMeta(
        "await agent('review this', { agentType: 'code-reviewer', model: 'anthropic/claude-haiku-4-5' })",
      ),
      runner,
      defaultAgent: "general",
      model: "anthropic/claude-sonnet-4-5",
    })
    expect(runner.created[0]?.agent).toBe("code-reviewer")
    expect(runner.created[0]?.model).toBe("anthropic/claude-haiku-4-5")
  })

  it("parallel() resolves throwing thunks to null and preserves order", async () => {
    const runner = scriptedRunner(() => "ok")
    const result = await runWorkflowScript({
      script: withMeta(
        [
          "const out = await parallel([",
          "  () => agent('first'),",
          "  () => { throw new Error('bad thunk') },",
          "  async () => 'plain value',",
          "])",
          "return out",
        ].join("\n"),
      ),
      runner,
      defaultAgent: "general",
    })
    expect(result.value).toEqual(["ok", null, "plain value"])
  })

  it("pipeline() passes (prev, originalItem, index) through stages and drops throwing items to null", async () => {
    const runner = scriptedRunner(() => "ok")
    const result = await runWorkflowScript({
      script: withMeta(
        [
          "const out = await pipeline(['a', 'b'],",
          "  (item) => item + '1',",
          "  (prev, item, index) => {",
          "    if (item === 'b') throw new Error('drop b')",
          "    return prev + item + index",
          "  },",
          ")",
          "return out",
        ].join("\n"),
      ),
      runner,
      defaultAgent: "general",
    })
    expect(result.value).toEqual(["a1a0", null])
  })

  it("pipeline() has no barrier between stages", async () => {
    const order: string[] = []
    let releaseSlow: (() => void) | undefined
    const slow = new Promise<void>((resolve) => {
      releaseSlow = resolve
    })
    const runner = scriptedRunner(() => "ok")
    const script = withMeta(
      [
        "await pipeline([0, 1],",
        "  async (item) => { await hooks.stage1(item); return item },",
        "  async (prev, item) => { hooks.stage2(item) },",
        ")",
      ].join("\n"),
    )
    // hooks is not a real engine global; emulate via args
    const result = runWorkflowScript({
      script: script.replace(/hooks/g, "args"),
      args: {
        stage1: (item: number) => (item === 0 ? slow : Promise.resolve()),
        stage2: (item: number) => order.push(`stage2:${item}`),
      },
      runner,
      defaultAgent: "general",
    })
    // Give item 1 time to flow through both stages while item 0 is stuck in stage 1.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(order).toEqual(["stage2:1"])
    releaseSlow?.()
    await result
    expect(order).toEqual(["stage2:1", "stage2:0"])
  })

  it("caps concurrent agent() calls with the semaphore", async () => {
    let active = 0
    let peak = 0
    const runner: SessionRunner = {
      async createChildSession() {
        return { sessionID: `s-${Math.floor(peak + active + 1)}` }
      },
      async runChildSession(input) {
        active += 1
        peak = Math.max(peak, active)
        await new Promise((resolve) => setTimeout(resolve, 10))
        active -= 1
        return { text: "ok", sessionID: input.sessionID }
      },
      async deleteSession() {},
    }
    await runWorkflowScript({
      script: withMeta(
        "await parallel([() => agent('a'), () => agent('b'), () => agent('c'), () => agent('d')])",
      ),
      runner,
      defaultAgent: "general",
      concurrency: 2,
    })
    expect(peak).toBeLessThanOrEqual(2)
  })

  it("enforces the token budget as a hard ceiling", async () => {
    const runner = scriptedRunner(() => ({ text: "ok", tokens: { output: 60 } }))
    await expect(
      runWorkflowScript({
        script: withMeta(
          [
            "await agent('first')",
            "await agent('second')",
            "return 'done'",
          ].join("\n"),
        ),
        runner,
        defaultAgent: "general",
        budgetTokens: 50,
      }),
    ).rejects.toThrow(/budget exhausted/i)
    expect(runner.runs).toHaveLength(1)
  })

  it("exposes budget totals to the script", async () => {
    const runner = scriptedRunner(() => ({ text: "ok", tokens: { output: 25 } }))
    const result = await runWorkflowScript({
      script: withMeta(
        [
          "const before = budget.remaining()",
          "await agent('spend')",
          "return { total: budget.total, before, after: budget.remaining(), spent: budget.spent() }",
        ].join("\n"),
      ),
      runner,
      defaultAgent: "general",
      budgetTokens: 100,
    })
    expect(result.value).toEqual({ total: 100, before: 100, after: 75, spent: 25 })
  })

  it("reports Infinity remaining with no budget", async () => {
    const runner = scriptedRunner(() => "ok")
    const result = await runWorkflowScript({
      script: withMeta("return { total: budget.total, remaining: budget.remaining() }"),
      runner,
      defaultAgent: "general",
    })
    expect(result.value).toEqual({ total: null, remaining: Infinity })
  })

  it("enforces the lifetime agent cap", async () => {
    const runner = scriptedRunner(() => "ok")
    await expect(
      runWorkflowScript({
        script: withMeta("for (let i = 0; i < 5; i += 1) await agent('call ' + i)"),
        runner,
        defaultAgent: "general",
        maxAgents: 3,
      }),
    ).rejects.toThrow(/lifetime cap/)
  })

  it("enforces the per-call item cap on parallel and pipeline", async () => {
    const runner = scriptedRunner(() => "ok")
    await expect(
      runWorkflowScript({
        script: withMeta("await parallel([() => 1, () => 2, () => 3])"),
        runner,
        defaultAgent: "general",
        maxItems: 2,
      }),
    ).rejects.toThrow(/at most 2 items/)
    await expect(
      runWorkflowScript({
        script: withMeta("await pipeline([1, 2, 3], (x) => x)"),
        runner,
        defaultAgent: "general",
        maxItems: 2,
      }),
    ).rejects.toThrow(/at most 2 items/)
  })

  it("throws on an unknown saved workflow name", async () => {
    const runner = scriptedRunner(() => "ok")
    await expect(
      runWorkflowScript({
        script: withMeta("await workflow('definitely-not-a-saved-workflow')"),
        runner,
        defaultAgent: "general",
      }),
    ).rejects.toThrow(/Unknown workflow "definitely-not-a-saved-workflow"/)
  })

  it("wraps script failures in WorkflowScriptError with partial state", async () => {
    const runner = scriptedRunner(() => "ok")
    const failure = await runWorkflowScript({
      script: withMeta(
        [
          "phase('Scan')",
          "log('before crash')",
          "await agent('works fine')",
          "throw new Error('script exploded')",
        ].join("\n"),
      ),
      runner,
      defaultAgent: "general",
    }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(WorkflowScriptError)
    const scriptError = failure as WorkflowScriptError
    expect(scriptError.message).toBe("script exploded")
    expect(scriptError.partial.phases).toEqual(["Scan"])
    expect(scriptError.partial.logs).toEqual(["before crash"])
    expect(scriptError.partial.agentCount).toBe(1)
  })

  it("emits phase/log/agent events with phase attribution", async () => {
    const events: string[] = []
    const runner = scriptedRunner(() => "ok")
    await runWorkflowScript({
      script: withMeta(
        [
          "phase('Find')",
          "await agent('finder task')",
          "await agent('verifier task', { phase: 'Verify', label: 'verify:1' })",
          "log('done')",
        ].join("\n"),
      ),
      runner,
      defaultAgent: "general",
      events: {
        onPhase: (title) => events.push(`phase:${title}`),
        onLog: (message) => events.push(`log:${message}`),
        onAgentStart: (event) => events.push(`start:${event.label}@${event.phase}`),
        onAgentEnd: (event) => events.push(`end:${event.label}@${event.phase}:${event.ok}`),
      },
    })
    expect(events).toEqual([
      "phase:Find",
      "start:finder task@Find",
      "end:finder task@Find:true",
      "start:verify:1@Verify",
      "end:verify:1@Verify:true",
      "log:done",
    ])
  })

  it("rejects Date.now() with a pass-via-args message", async () => {
    const runner = scriptedRunner(() => "ok")
    await expect(
      runWorkflowScript({
        script: withMeta("return Date.now()"),
        runner,
        defaultAgent: "general",
      }),
    ).rejects.toThrow(/Date\.now\(\).*deterministic.*via args/)
  })

  it("rejects argless new Date()", async () => {
    const runner = scriptedRunner(() => "ok")
    await expect(
      runWorkflowScript({
        script: withMeta("return new Date()"),
        runner,
        defaultAgent: "general",
      }),
    ).rejects.toThrow(/new Date\(\) without arguments.*deterministic.*via args/)
  })

  it("keeps new Date(value) and the rest of Date working", async () => {
    const runner = scriptedRunner(() => "ok")
    const result = await runWorkflowScript({
      script: withMeta(
        [
          "const epoch = new Date(0)",
          "return {",
          "  time: epoch.getTime(),",
          "  iso: epoch.toISOString(),",
          "  isDate: epoch instanceof Date,",
          "  parsed: Date.parse('1970-01-01T00:00:00.000Z'),",
          "  utc: Date.UTC(1970, 0, 1),",
          "}",
        ].join("\n"),
      ),
      runner,
      defaultAgent: "general",
    })
    expect(result.value).toEqual({
      time: 0,
      iso: "1970-01-01T00:00:00.000Z",
      isDate: true,
      parsed: 0,
      utc: 0,
    })
  })

  it("rejects Math.random() with a pass-via-args message", async () => {
    const runner = scriptedRunner(() => "ok")
    await expect(
      runWorkflowScript({
        script: withMeta("return Math.random()"),
        runner,
        defaultAgent: "general",
      }),
    ).rejects.toThrow(/Math\.random\(\).*deterministic.*via args/)
  })

  it("keeps the rest of Math working", async () => {
    const runner = scriptedRunner(() => "ok")
    const result = await runWorkflowScript({
      script: withMeta(
        "return { floor: Math.floor(4.7), max: Math.max(1, 9, 3), pi: Math.PI }",
      ),
      runner,
      defaultAgent: "general",
    })
    expect(result.value).toEqual({ floor: 4, max: 9, pi: Math.PI })
  })

  it("throws when aborted before an agent call", async () => {
    const controller = new AbortController()
    controller.abort()
    const runner = scriptedRunner(() => "ok")
    await expect(
      runWorkflowScript({
        script: withMeta("await agent('never runs')"),
        runner,
        defaultAgent: "general",
        abort: controller.signal,
      }),
    ).rejects.toThrow(/aborted/i)
  })
})

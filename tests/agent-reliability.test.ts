import { describe, expect, it } from "vitest"
import { runWorkflowScript, WorkflowScriptError, SUBAGENT_SYSTEM_PROMPT } from "../src/script/engine.js"
import type {
  RunChildSessionInput,
  RunChildSessionResult,
  SessionRunner,
} from "../src/runtime/types.js"

interface ScriptedRunner extends SessionRunner {
  runs: RunChildSessionInput[]
}

function scriptedRunner(
  respond: (input: RunChildSessionInput, runIndex: number) => Partial<RunChildSessionResult>,
  extras: Partial<SessionRunner> = {},
): ScriptedRunner {
  const runs: RunChildSessionInput[] = []
  let counter = 0
  return {
    runs,
    async createChildSession() {
      counter += 1
      return { sessionID: `s-${counter}` }
    },
    async runChildSession(input) {
      const index = runs.length
      runs.push(input)
      return { text: "", sessionID: input.sessionID, ...respond(input, index) }
    },
    async deleteSession() {},
    ...extras,
  }
}

function withMeta(body: string): string {
  return `export const meta = { name: 'rel', description: 'reliability' }\n${body}`
}

const NO_BACKOFF = { agentRetryBackoffMs: 0 }

describe("transient failures are retried before agent() gives up", () => {
  it("retries a rate limit and returns the eventual success", async () => {
    const runner = scriptedRunner((_input, index) =>
      index < 2 ? { error: "429 rate limit exceeded" } : { text: "recovered" },
    )
    const result = await runWorkflowScript({
      script: withMeta("return await agent('do it')"),
      runner,
      defaultAgent: "general",
      ...NO_BACKOFF,
    })
    expect(result.value).toBe("recovered")
    expect(runner.runs).toHaveLength(3)
  })

  it("gives up after the retry budget and returns null", async () => {
    const runner = scriptedRunner(() => ({ error: "503 service unavailable" }))
    const result = await runWorkflowScript({
      script: withMeta("return await agent('do it')"),
      runner,
      defaultAgent: "general",
      agentRetries: 2,
      ...NO_BACKOFF,
    })
    expect(result.value).toBeNull()
    expect(runner.runs).toHaveLength(3)
  })

  it("does not retry a terminal failure", async () => {
    const runner = scriptedRunner(() => ({ error: "invalid api key" }))
    const result = await runWorkflowScript({
      script: withMeta("return await agent('do it')"),
      runner,
      defaultAgent: "general",
      ...NO_BACKOFF,
    })
    expect(result.value).toBeNull()
    expect(runner.runs).toHaveLength(1)
  })

  it("counts every attempt's tokens against the budget", async () => {
    const runner = scriptedRunner((_input, index) =>
      index === 0
        ? { error: "connection reset", tokens: { output: 10 } }
        : { text: "ok", tokens: { output: 5 } },
    )
    const result = await runWorkflowScript({
      script: withMeta("await agent('do it')\nreturn budget.spent()"),
      runner,
      defaultAgent: "general",
      ...NO_BACKOFF,
    })
    expect(result.value).toBe(15)
  })
})

describe("subagents are told their final text is the return value", () => {
  it("sends the framing as a system prompt, not in the user prompt", async () => {
    const runner = scriptedRunner(() => ({ text: "ok" }))
    await runWorkflowScript({
      script: withMeta("await agent('exact prompt')"),
      runner,
      defaultAgent: "general",
    })
    expect(runner.runs[0]?.system).toBe(SUBAGENT_SYSTEM_PROMPT)
    expect(SUBAGENT_SYSTEM_PROMPT).toMatch(/return value/)
    // Keeping it out of the prompt keeps it out of the resume hash.
    expect(runner.runs[0]?.prompt).toBe("exact prompt")
  })
})

describe("agentType is validated against the agent registry", () => {
  it("rejects an unknown agent before a session is spawned", async () => {
    const runner = scriptedRunner(() => ({ text: "ok" }), {
      listAgents: async () => ["general", "plan", "code-reviewer"],
    })
    const failure = await runWorkflowScript({
      script: withMeta("return await agent('x', { agentType: 'code-revewer' })"),
      runner,
      defaultAgent: "general",
    }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(WorkflowScriptError)
    const message = (failure as WorkflowScriptError).message
    expect(message).toContain('"code-revewer"')
    expect(message).toContain('"code-reviewer"')
    expect(runner.runs).toHaveLength(0)
    // Rejected ahead of the seq assignment, like effort and isolation.
    expect((failure as WorkflowScriptError).partial.agentCount).toBe(0)
  })

  it("fails the run from inside parallel() rather than yielding a null item", async () => {
    const runner = scriptedRunner(() => ({ text: "ok" }), {
      listAgents: async () => ["general"],
    })
    await expect(
      runWorkflowScript({
        script: withMeta("return await parallel([() => agent('a', { agentType: 'nope' })])"),
        runner,
        defaultAgent: "general",
      }),
    ).rejects.toThrow(/unknown agentType/)
  })

  it("accepts a known agent and reads the registry only once", async () => {
    let calls = 0
    const runner = scriptedRunner(() => ({ text: "ok" }), {
      listAgents: async () => {
        calls += 1
        return ["general", "plan"]
      },
    })
    const result = await runWorkflowScript({
      script: withMeta(
        "return await parallel([() => agent('a', { agentType: 'plan' }), () => agent('b', { agentType: 'plan' })])",
      ),
      runner,
      defaultAgent: "general",
    })
    expect(result.value).toEqual(["ok", "ok"])
    expect(calls).toBe(1)
  })

  it("passes the agent through unchecked when the registry cannot be read", async () => {
    const runner = scriptedRunner(() => ({ text: "ok" }), {
      listAgents: async () => undefined,
    })
    const result = await runWorkflowScript({
      script: withMeta("return await agent('x', { agentType: 'custom-thing' })"),
      runner,
      defaultAgent: "general",
    })
    expect(result.value).toBe("ok")
    expect(runner.runs[0]?.agent).toBe("custom-thing")
  })

  it("never asks for the registry when no call sets agentType", async () => {
    let calls = 0
    const runner = scriptedRunner(() => ({ text: "ok" }), {
      listAgents: async () => {
        calls += 1
        return ["general"]
      },
    })
    await runWorkflowScript({
      script: withMeta("await agent('x')"),
      runner,
      defaultAgent: "general",
    })
    expect(calls).toBe(0)
  })
})

describe("run limits are fatal, not silent nulls", () => {
  it("fails the run when the lifetime cap is breached inside parallel()", async () => {
    const runner = scriptedRunner(() => ({ text: "ok" }))
    await expect(
      runWorkflowScript({
        script: withMeta("return await parallel([() => agent('a'), () => agent('b'), () => agent('c')])"),
        runner,
        defaultAgent: "general",
        maxAgents: 2,
      }),
    ).rejects.toThrow(/2-agent lifetime cap/)
  })

  it("fails the run when the budget is breached inside pipeline()", async () => {
    const runner = scriptedRunner(() => ({ text: "ok", tokens: { output: 60 } }))
    await expect(
      runWorkflowScript({
        script: withMeta("return await pipeline(['a', 'b'], (item) => agent('do ' + item))"),
        runner,
        defaultAgent: "general",
        concurrency: 1,
        budgetTokens: 50,
      }),
    ).rejects.toThrow(/budget exhausted/i)
  })

  it("fails the run on an empty prompt inside parallel()", async () => {
    const runner = scriptedRunner(() => ({ text: "ok" }))
    await expect(
      runWorkflowScript({
        script: withMeta("return await parallel([() => agent('   ')])"),
        runner,
        defaultAgent: "general",
      }),
    ).rejects.toThrow(/non-empty prompt/)
  })
})

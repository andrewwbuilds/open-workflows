import { describe, expect, it } from "vitest"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
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

  it("maps a Claude Code agent name onto its OpenCode equivalent", async () => {
    const runner = scriptedRunner(() => ({ text: "ok" }), {
      listAgents: async () => ["general", "explore", "plan"],
    })
    const result = await runWorkflowScript({
      script: withMeta("return await agent('x', { agentType: 'Explore' })"),
      runner,
      defaultAgent: "general",
    })
    expect(result.value).toBe("ok")
    expect(runner.runs[0]?.agent).toBe("explore")
  })

  it("logs the rewrite once no matter how many calls use the name", async () => {
    const runner = scriptedRunner(() => ({ text: "ok" }), {
      listAgents: async () => ["general", "explore", "plan"],
    })
    const result = await runWorkflowScript({
      script: withMeta(
        "return await parallel([() => agent('a', { agentType: 'Explore' }), () => agent('b', { agentType: 'Explore' })])",
      ),
      runner,
      defaultAgent: "general",
    })
    expect(result.value).toEqual(["ok", "ok"])
    expect(runner.runs.map((run) => run.agent)).toEqual(["explore", "explore"])
    expect(result.logs.filter((line) => /is a Claude Code name/.test(line))).toHaveLength(1)
  })

  it("rejects a Claude Code agent with no OpenCode equivalent by name", async () => {
    const runner = scriptedRunner(() => ({ text: "ok" }), {
      listAgents: async () => ["general", "explore"],
    })
    const failure = await runWorkflowScript({
      script: withMeta("return await agent('x', { agentType: 'statusline-setup' })"),
      runner,
      defaultAgent: "general",
    }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(WorkflowScriptError)
    expect((failure as Error).message).toMatch(/no OpenCode agent to map it onto/)
    expect(runner.runs).toHaveLength(0)
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

// Claude Code's contract composes to this: "once spent() reaches total,
// further agent() calls throw" plus "a thunk that throws resolves to null - the
// call itself NEVER rejects". So a breached ceiling is a null item, and the
// breach is explained by a log line and result.limitBreach instead.
describe("run limits degrade to null inside a fan-out", () => {
  it("nulls the calls past the lifetime cap inside parallel()", async () => {
    const runner = scriptedRunner(() => ({ text: "ok" }))
    const result = await runWorkflowScript({
      script: withMeta("return await parallel([() => agent('a'), () => agent('b'), () => agent('c')])"),
      runner,
      defaultAgent: "general",
      maxAgents: 2,
    })
    expect(result.value).toEqual(["ok", "ok", null])
    expect(result.limitBreach).toMatch(/2-agent lifetime cap/)
    expect(runner.runs).toHaveLength(2)
  })

  it("nulls the calls past the budget inside pipeline()", async () => {
    const runner = scriptedRunner(() => ({ text: "ok", tokens: { output: 60 } }))
    const result = await runWorkflowScript({
      script: withMeta("return await pipeline(['a', 'b'], (item) => agent('do ' + item))"),
      runner,
      defaultAgent: "general",
      concurrency: 1,
      budgetTokens: 50,
    })
    expect(result.value).toEqual(["ok", null])
    expect(result.limitBreach).toMatch(/budget exhausted/i)
    expect(runner.runs).toHaveLength(1)
  })

  it("logs the breach once across a wide fan-out", async () => {
    const runner = scriptedRunner(() => ({ text: "ok", tokens: { output: 60 } }))
    const result = await runWorkflowScript({
      script: withMeta(
        "return await parallel(Array.from({ length: 20 }, (_, i) => () => agent('do ' + i)))",
      ),
      runner,
      defaultAgent: "general",
      concurrency: 1,
      budgetTokens: 50,
    })
    expect((result.value as unknown[]).filter((entry) => entry === null)).toHaveLength(19)
    expect(result.logs.filter((line) => /budget exhausted/i.test(line))).toHaveLength(1)
  })

  it("leaks no semaphore slot when a queued call finds the budget exhausted", async () => {
    const runner = scriptedRunner(() => ({ text: "ok", tokens: { output: 60 } }))
    const result = await runWorkflowScript({
      script: withMeta(
        [
          "const fanned = await parallel([() => agent('a'), () => agent('b'), () => agent('c')])",
          "return fanned",
        ].join("\n"),
      ),
      runner,
      defaultAgent: "general",
      concurrency: 1,
      // Every queued call after the first is rejected, so each one must give
      // its slot back before throwing or the fan-out would hang.
      budgetTokens: 50,
    })
    expect(result.value).toEqual(["ok", null, null])
  })

  it("nulls a nested workflow()'s limit breach when the call sits in parallel()", async () => {
    const runner = scriptedRunner(() => ({ text: "ok" }))
    const child = withMeta("return await agent('child work')")
    const workingDirectory = await mkdtemp(join(tmpdir(), "wf-limit-"))
    await mkdir(join(workingDirectory, ".opencode", "workflows"), { recursive: true })
    await writeFile(join(workingDirectory, ".opencode", "workflows", "child.js"), child, "utf8")
    const result = await runWorkflowScript({
      script: withMeta("return await parallel([() => agent('a'), () => workflow('child')])"),
      runner,
      defaultAgent: "general",
      workingDirectory,
      maxAgents: 1,
    })
    expect(result.value).toEqual(["ok", null])
    expect(result.limitBreach).toMatch(/1-agent lifetime cap/)
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

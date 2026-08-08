import { describe, expect, it } from "vitest"
import { runWorkflowScript, WorkflowScriptError } from "../src/script/engine.js"
import { createSdkRunner, type OpencodeClientLike } from "../src/runtime/sdk.js"

/**
 * OpenCode stores a tool-using subagent turn as ONE ASSISTANT MESSAGE PER STEP
 * and POST /session/{id}/message returns only the LAST of them, while
 * GET /session/{id} reports the session's committed aggregate. Verified against
 * opencode 1.15.10: a 6-step child answered with `tokens.output: 5` on the
 * returned message and `tokens.output: 30` on the session.
 *
 * Every fixture below therefore models a turn as several assistant messages,
 * each ending in a `step-finish` part, which is what the live server produces.
 */
function stepMessage(
  sessionID: string,
  id: string,
  options: { output: number; text?: string; tool?: boolean },
): { info: Record<string, unknown>; parts: Array<Record<string, unknown>> } {
  const parts: Array<Record<string, unknown>> = [
    { id: `${id}-a`, sessionID, messageID: id, type: "step-start" },
  ]
  if (options.text !== undefined) {
    parts.push({ id: `${id}-b`, sessionID, messageID: id, type: "text", text: options.text })
  }
  if (options.tool) {
    parts.push({ id: `${id}-c`, sessionID, messageID: id, type: "tool", tool: "read", state: { status: "completed" } })
  }
  parts.push({ id: `${id}-d`, sessionID, messageID: id, type: "step-finish" })
  return {
    info: {
      id,
      sessionID,
      role: "assistant",
      parentID: "x",
      mode: "x",
      modelID: "canned-model",
      providerID: "canned",
      path: { cwd: "/tmp", root: "/tmp" },
      cost: 0,
      time: { created: 0, completed: 1 },
      tokens: { input: 10, output: options.output, reasoning: 0, cache: { read: 0, write: 0 } },
      finish: "stop",
    },
    parts,
  }
}

interface MultiStepOptions {
  /** Committed output tokens the session aggregate reports after each prompt. */
  sessionTotals: number[]
  /** Output tokens on the single message each prompt returns. */
  lastStepOutput?: number
  /** Omit session.get entirely, as an older host would. */
  noSessionGet?: boolean
  /** Make session.get fail. */
  sessionGetError?: boolean
}

function multiStepClient(options: MultiStepOptions): OpencodeClientLike & { sessionGets: string[] } {
  const sessionGets: string[] = []
  let created = 0
  const totals = new Map<string, number[]>()
  const client = {
    sessionGets,
    session: {
      create: async () => {
        created += 1
        return { data: { id: `ses_child_${created}` } }
      },
      prompt: async (opts: { path: { id: string } }) => {
        const id = opts.path.id
        // Each prompt advances that session through the scripted totals.
        const remaining = totals.get(id) ?? options.sessionTotals.slice()
        const next = remaining.shift()
        totals.set(id, remaining)
        if (next !== undefined) client.__totals.set(id, next)
        return { data: stepMessage(id, `msg_${id}_${options.sessionTotals.length - remaining.length}`, {
          output: options.lastStepOutput ?? 5,
          text: "DONE",
        }) }
      },
      delete: async () => ({ data: true }),
      ...(options.noSessionGet
        ? {}
        : {
            get: async (opts: { path: { id: string } }) => {
              sessionGets.push(opts.path.id)
              if (options.sessionGetError) return { error: { data: { message: "boom" } } }
              return {
                data: {
                  id: opts.path.id,
                  title: "t",
                  tokens: {
                    input: 60,
                    output: client.__totals.get(opts.path.id) ?? 0,
                    reasoning: 0,
                    cache: { read: 0, write: 0 },
                  },
                },
              }
            },
          }),
    },
    __totals: new Map<string, number>(),
  }
  return client as unknown as OpencodeClientLike & { sessionGets: string[] }
}

describe("a subagent turn's output tokens are read from the session, not one step", () => {
  it("reports the whole multi-step turn, not just the returned message", async () => {
    const client = multiStepClient({ sessionTotals: [30] })
    const runner = createSdkRunner(client, "parent")
    const session = await runner.createChildSession({ title: "a0", agent: "general" })
    const result = await runner.runChildSession({
      sessionID: session.sessionID,
      agent: "general",
      prompt: "task 0",
    })
    expect(result.text).toBe("DONE")
    // The returned message carried 5; the session's six steps really burned 30.
    expect(result.tokens?.output).toBe(30)
    expect(client.sessionGets).toEqual([session.sessionID])
  })

  it("reports each later prompt on the same session as a delta", async () => {
    const client = multiStepClient({ sessionTotals: [30, 50, 51] })
    const runner = createSdkRunner(client, "parent")
    const session = await runner.createChildSession({ title: "a0", agent: "general" })
    const outputs: Array<number | undefined> = []
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await runner.runChildSession({
        sessionID: session.sessionID,
        agent: "general",
        prompt: "retry",
      })
      outputs.push(result.tokens?.output)
    }
    // The schema-retry loop re-prompts the same session; the aggregate is
    // cumulative, so only the increment belongs to each turn.
    expect(outputs).toEqual([30, 20, 1])
  })

  it("keeps per-session totals apart in a fan-out", async () => {
    const client = multiStepClient({ sessionTotals: [30] })
    const runner = createSdkRunner(client, "parent")
    const first = await runner.createChildSession({ title: "a0", agent: "general" })
    const second = await runner.createChildSession({ title: "a1", agent: "general" })
    const results = await Promise.all(
      [first, second].map((session) =>
        runner.runChildSession({ sessionID: session.sessionID, agent: "general", prompt: "go" }),
      ),
    )
    expect(results.map((result) => result.tokens?.output)).toEqual([30, 30])
  })

  it("never reports a negative delta if the aggregate goes backwards", async () => {
    const client = multiStepClient({ sessionTotals: [30, 4] })
    const runner = createSdkRunner(client, "parent")
    const session = await runner.createChildSession({ title: "a0", agent: "general" })
    await runner.runChildSession({ sessionID: session.sessionID, agent: "general", prompt: "one" })
    const second = await runner.runChildSession({
      sessionID: session.sessionID,
      agent: "general",
      prompt: "two",
    })
    expect(second.tokens?.output).toBe(0)
  })

  it("falls back to the message's own count when the session read fails", async () => {
    const client = multiStepClient({ sessionTotals: [30], sessionGetError: true, lastStepOutput: 7 })
    const runner = createSdkRunner(client, "parent")
    const session = await runner.createChildSession({ title: "a0", agent: "general" })
    const result = await runner.runChildSession({
      sessionID: session.sessionID,
      agent: "general",
      prompt: "go",
    })
    expect(result.tokens?.output).toBe(7)
  })

  it("falls back on a host whose client has no session.get at all", async () => {
    const client = multiStepClient({ sessionTotals: [30], noSessionGet: true, lastStepOutput: 7 })
    const runner = createSdkRunner(client, "parent")
    const session = await runner.createChildSession({ title: "a0", agent: "general" })
    const result = await runner.runChildSession({
      sessionID: session.sessionID,
      agent: "general",
      prompt: "go",
    })
    expect(result.tokens?.output).toBe(7)
  })

  it("makes budgetTokens a real ceiling over multi-step subagents", async () => {
    const client = multiStepClient({ sessionTotals: [30] })
    const runner = createSdkRunner(client, "parent")
    const run = runWorkflowScript({
      script: [
        "export const meta = { name: 'b', description: 'b' }",
        "const out = []",
        "for (let i = 0; i < 3; i++) out.push(await agent('task ' + i, { label: 'a' + i }))",
        "return out.join(',')",
      ].join("\n"),
      runner,
      defaultAgent: "general",
      budgetTokens: 20,
    })
    // Before the fix this reported 15 for three agents that really spent 90 and
    // the ceiling never tripped. Now the first agent alone exhausts it, which
    // is what the live harness showed after the fix.
    const error = (await run.catch((thrown: unknown) => thrown)) as WorkflowScriptError
    expect(error).toBeInstanceOf(WorkflowScriptError)
    expect(error.message).toContain("Token budget exhausted: spent 30 of 20 output tokens")
    expect(error.partial.tokensSpent).toBe(30)
    expect(error.partial.sessionIDs).toHaveLength(1)
  })
})

describe("the parent turn's committed output tokens", () => {
  function parentClient(messages: Array<{ info: Record<string, unknown> }>): OpencodeClientLike {
    return {
      session: { messages: async () => ({ data: messages }) },
    } as unknown as OpencodeClientLike
  }

  const assistantStep = (id: string, output: number) => ({
    info: { id, role: "assistant", tokens: { output }, time: { created: 0 } },
  })
  const userTurn = (id: string) => ({ info: { id, role: "user", time: { created: 0 } } })

  it("sums every step of the current turn, not only the named message", async () => {
    const runner = createSdkRunner(
      parentClient([
        userTurn("u1"),
        assistantStep("m1", 100),
        userTurn("u2"),
        assistantStep("m2", 11),
        assistantStep("m3", 22),
        assistantStep("m4", 33),
      ]),
      "parent",
    )
    // The main loop opened three assistant messages before calling this tool;
    // reading only m4 would have hidden 33 of the 66 already spent.
    expect(await runner.readTurnOutputTokens?.("m4")).toBe(66)
  })

  it("stops at the previous user message so an older turn is not counted", async () => {
    const runner = createSdkRunner(
      parentClient([userTurn("u1"), assistantStep("m1", 100), userTurn("u2"), assistantStep("m2", 7)]),
      "parent",
    )
    expect(await runner.readTurnOutputTokens?.("m2")).toBe(7)
  })

  it("returns undefined when the message is not part of the latest turn", async () => {
    const runner = createSdkRunner(
      parentClient([userTurn("u1"), assistantStep("m1", 100), userTurn("u2"), assistantStep("m2", 7)]),
      "parent",
    )
    expect(await runner.readTurnOutputTokens?.("m1")).toBeUndefined()
    expect(await runner.readTurnOutputTokens?.("nope")).toBeUndefined()
  })

  it("counts a step with no usage recorded as zero rather than dropping the turn", async () => {
    const runner = createSdkRunner(
      parentClient([userTurn("u1"), { info: { id: "m1", role: "assistant" } }, assistantStep("m2", 4)]),
      "parent",
    )
    expect(await runner.readTurnOutputTokens?.("m2")).toBe(4)
  })
})

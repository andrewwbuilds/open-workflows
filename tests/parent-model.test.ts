import { describe, expect, it } from "vitest"
import { createSdkRunner, type OpencodeClientLike } from "../src/runtime/sdk.js"

interface MessageStub {
  info: { role: string; providerID?: string; modelID?: string }
}

function clientWithMessages(
  messages: MessageStub[],
  options: { error?: unknown; onCall?: () => void } = {},
): OpencodeClientLike {
  return {
    session: {
      messages: async () => {
        options.onCall?.()
        if (options.error) return { error: options.error }
        return { data: messages }
      },
    },
  } as unknown as OpencodeClientLike
}

const assistant = (providerID: string, modelID: string): MessageStub => ({
  info: { role: "assistant", providerID, modelID },
})
const user = (): MessageStub => ({ info: { role: "user" } })

describe("parent session model resolution", () => {
  it("returns the most recent assistant turn's model", async () => {
    const runner = createSdkRunner(
      clientWithMessages([
        user(),
        assistant("anthropic", "claude-sonnet-4-5"),
        user(),
        assistant("openai", "gpt-5.6-luna"),
      ]),
      "parent-1",
    )
    // A mid-session model switch must win over the earlier turns.
    expect(await runner.resolveParentModel?.()).toBe("openai/gpt-5.6-luna")
  })

  it("skips user messages and assistant turns with no model recorded", async () => {
    const runner = createSdkRunner(
      clientWithMessages([
        assistant("anthropic", "claude-sonnet-4-5"),
        { info: { role: "assistant" } },
        user(),
      ]),
      "parent-1",
    )
    expect(await runner.resolveParentModel?.()).toBe("anthropic/claude-sonnet-4-5")
  })

  it("resolves to undefined when the session has no assistant turn yet", async () => {
    const runner = createSdkRunner(clientWithMessages([user()]), "parent-1")
    expect(await runner.resolveParentModel?.()).toBeUndefined()
  })

  it("falls back to undefined rather than throwing when the API errors", async () => {
    const runner = createSdkRunner(
      clientWithMessages([], { error: { message: "boom" } }),
      "parent-1",
    )
    expect(await runner.resolveParentModel?.()).toBeUndefined()
  })

  it("resolves once and memoizes, including a negative result", async () => {
    let calls = 0
    const runner = createSdkRunner(
      clientWithMessages([user()], { onCall: () => { calls += 1 } }),
      "parent-1",
    )
    expect(await runner.resolveParentModel?.()).toBeUndefined()
    expect(await runner.resolveParentModel?.()).toBeUndefined()
    expect(calls).toBe(1)
  })

  it("memoizes a positive result too", async () => {
    let calls = 0
    const runner = createSdkRunner(
      clientWithMessages([assistant("anthropic", "claude-opus-5")], {
        onCall: () => { calls += 1 },
      }),
      "parent-1",
    )
    expect(await runner.resolveParentModel?.()).toBe("anthropic/claude-opus-5")
    expect(await runner.resolveParentModel?.()).toBe("anthropic/claude-opus-5")
    expect(calls).toBe(1)
  })
})

import { describe, expect, it } from "vitest"
import { runWorkflowScript, WorkflowScriptError } from "../src/script/engine.js"
import { createSdkRunner, type OpencodeClientLike } from "../src/runtime/sdk.js"
import { createFakeRunner } from "../src/runtime/fake.js"
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
  }
}

function withMeta(body: string): string {
  return `export const meta = { name: 'so', description: 'structured output' }\n${body}`
}

const SCHEMA = "{ type: 'object', properties: { count: { type: 'integer' } }, required: ['count'], additionalProperties: false }"
const CALL = `return await agent('count things', { schema: ${SCHEMA} })`

describe("native json_schema structured output", () => {
  it("sends the schema on the prompt and returns the captured value without retrying", async () => {
    const runner = scriptedRunner(() => ({ structured: { count: 3 }, text: "" }))
    const result = await runWorkflowScript({
      script: withMeta(CALL),
      runner,
      defaultAgent: "general",
    })
    expect(result.value).toEqual({ count: 3 })
    expect(runner.runs).toHaveLength(1)
    expect(runner.runs[0]?.schema).toEqual({
      type: "object",
      properties: { count: { type: "integer" } },
      required: ["count"],
      additionalProperties: false,
    })
  })

  it("keeps the prompt instruction alongside the native schema", async () => {
    // The instruction is the only thing that recovers the call on a server that
    // drops the unknown `format` field, or on a model that ignores the forced
    // tool call, so it must not be dropped as redundant.
    const runner = scriptedRunner(() => ({ structured: { count: 1 } }))
    await runWorkflowScript({ script: withMeta(CALL), runner, defaultAgent: "general" })
    expect(runner.runs[0]?.prompt).toContain("JSON Schema")
  })

  it("rejects a natively captured value that violates the schema and re-prompts", async () => {
    // OpenCode attaches no validator to the StructuredOutput tool, so it hands
    // back whatever the model passed. This is the guard for that.
    const runner = scriptedRunner((_input, index) =>
      index === 0
        ? { structured: { count: "seven", extra: 1 } }
        : { structured: { count: 7 } },
    )
    const result = await runWorkflowScript({
      script: withMeta(CALL),
      runner,
      defaultAgent: "general",
    })
    expect(result.value).toEqual({ count: 7 })
    expect(runner.runs).toHaveLength(2)
    expect(runner.runs[1]?.prompt).toContain("must be integer")
  })

  it("rejects an extra property under additionalProperties: false", async () => {
    const runner = scriptedRunner(() => ({ structured: { count: 1, sneaky: true } }))
    const result = await runWorkflowScript({
      script: withMeta(CALL),
      runner,
      defaultAgent: "general",
      schemaRetries: 0,
    })
    expect(result.value).toBeNull()
  })

  it("falls back to scraping the text when the model never called the tool", async () => {
    const runner = scriptedRunner(() => ({ text: 'Here you go:\n```json\n{"count": 4}\n```' }))
    const result = await runWorkflowScript({
      script: withMeta(CALL),
      runner,
      defaultAgent: "general",
    })
    expect(result.value).toEqual({ count: 4 })
    expect(runner.runs).toHaveLength(1)
  })

  it("retries with the schema attached, then returns null", async () => {
    const runner = scriptedRunner(() => ({ text: "no json here" }))
    const result = await runWorkflowScript({
      script: withMeta(CALL),
      runner,
      defaultAgent: "general",
      schemaRetries: 2,
    })
    expect(result.value).toBeNull()
    expect(runner.runs).toHaveLength(3)
    expect(runner.runs.every((run) => run.schema !== undefined)).toBe(true)
  })

  it("drops native enforcement and retries on a provider that rejects the forced tool call", async () => {
    // Extended-thinking models answer tool_choice:"required" with a 400 and no
    // output at all, which would regress a call that works via the instruction.
    const runner = scriptedRunner((input) =>
      input.schema
        ? {
            error: "Error from provider: Thinking mode does not support this tool_choice",
            errorName: "APIError",
          }
        : { text: '{"count": 9}' },
    )
    const result = await runWorkflowScript({
      script: withMeta(CALL),
      runner,
      defaultAgent: "general",
    })
    expect(result.value).toEqual({ count: 9 })
    expect(runner.runs).toHaveLength(2)
    expect(runner.runs[0]?.schema).toBeDefined()
    expect(runner.runs[1]?.schema).toBeUndefined()
    expect(result.logs.some((entry) => entry.includes("provider rejected native structured output"))).toBe(true)
  })

  it("keeps native enforcement off for the rest of the session after a provider rejection", async () => {
    const runner = scriptedRunner((input) =>
      input.schema
        ? { error: "unsupported tool_choice", errorName: "APIError" }
        : { text: "still not json" },
    )
    const result = await runWorkflowScript({
      script: withMeta(CALL),
      runner,
      defaultAgent: "general",
      schemaRetries: 1,
    })
    expect(result.value).toBeNull()
    // One rejected native call, then the fallback call and its one retry - the
    // native path must not be re-attempted on every retry.
    expect(runner.runs.map((run) => run.schema !== undefined)).toEqual([true, false, false])
  })

  it("sends no schema when the call declares none", async () => {
    const runner = scriptedRunner(() => ({ text: "plain" }))
    await runWorkflowScript({
      script: withMeta("return await agent('just talk')"),
      runner,
      defaultAgent: "general",
    })
    expect(runner.runs[0]?.schema).toBeUndefined()
  })

  it("rejects a schema whose keywords the validator cannot evaluate", async () => {
    const runner = scriptedRunner(() => ({ text: "ok" }))
    const failure = await runWorkflowScript({
      script: withMeta(
        "return await agent('x', { schema: { type: 'object', properties: { a: { $ref: '#/$defs/A' } }, $defs: { A: { type: 'string' } } } })",
      ),
      runner,
      defaultAgent: "general",
    }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(WorkflowScriptError)
    const message = (failure as WorkflowScriptError).message
    expect(message).toContain("$defs")
    expect(message).toContain("properties.a.$ref")
    // Rejected before a session is spawned, like every other bad option.
    expect(runner.runs).toHaveLength(0)
  })
})

describe("SdkRunner structured-output plumbing", () => {
  function client(
    capture: (body: Record<string, unknown>) => void,
    reply: { info?: Record<string, unknown>; parts?: unknown[] } = {},
  ): OpencodeClientLike {
    return {
      session: {
        create: async () => ({ data: { id: "s-1" } }),
        prompt: async (opts: { body: Record<string, unknown> }) => {
          capture(opts.body)
          return { data: { info: reply.info ?? {}, parts: reply.parts ?? [] } }
        },
        delete: async () => ({ data: true }),
      },
    } as unknown as OpencodeClientLike
  }

  it("puts format on the body and omits retryCount and tools", async () => {
    const bodies: Array<Record<string, unknown>> = []
    const runner = createSdkRunner(client((body) => bodies.push(body)), "parent")
    await runner.runChildSession({
      sessionID: "s-1",
      agent: "general",
      prompt: "go",
      schema: { type: "object" },
    })
    expect(bodies[0]?.format).toEqual({ type: "json_schema", schema: { type: "object" } })
    // retryCount is inert in OpenCode 1.15 and tools:{StructuredOutput:false}
    // would disable the injected tool outright.
    expect(bodies[0]).not.toHaveProperty("retryCount")
    expect(bodies[0]).not.toHaveProperty("tools")
  })

  it("omits format when no schema is given", async () => {
    const bodies: Array<Record<string, unknown>> = []
    const runner = createSdkRunner(client((body) => bodies.push(body)), "parent")
    await runner.runChildSession({ sessionID: "s-1", agent: "general", prompt: "go" })
    expect(bodies[0]).not.toHaveProperty("format")
  })

  it("surfaces info.structured", async () => {
    const runner = createSdkRunner(
      client(() => {}, { info: { structured: { city: "Paris" } } }),
      "parent",
    )
    const result = await runner.runChildSession({ sessionID: "s-1", agent: "general", prompt: "go" })
    expect(result.structured).toEqual({ city: "Paris" })
  })

  it("reads the error message out of error.data, not error.message", async () => {
    // The wire shape is { name, data: { message } }. Reading `.message`
    // directly always yielded undefined, so every hard failure - a
    // StructuredOutputError, a 400 from the provider - read as an empty success.
    const runner = createSdkRunner(
      client(() => {}, {
        info: {
          error: {
            name: "StructuredOutputError",
            data: { message: "Model did not produce structured output", retries: 0 },
          },
        },
      }),
      "parent",
    )
    const result = await runner.runChildSession({ sessionID: "s-1", agent: "general", prompt: "go" })
    expect(result.error).toBe("Model did not produce structured output")
    expect(result.errorName).toBe("StructuredOutputError")
  })

  it("still reports an error that carries no data.message", async () => {
    const runner = createSdkRunner(
      client(() => {}, { info: { error: { name: "APIError" } } }),
      "parent",
    )
    const result = await runner.runChildSession({ sessionID: "s-1", agent: "general", prompt: "go" })
    expect(result.error).toBe("APIError")
    expect(result.errorName).toBe("APIError")
  })
})

describe("a StructuredOutputError is a schema miss, not a failed call", () => {
  function runnerWith(turns: Array<{ text?: string; structured?: unknown; errorName?: string }>) {
    const sent: string[] = []
    let index = 0
    const runner = createFakeRunner({ defaultResponse: "" })
    runner.runChildSession = async (input) => {
      sent.push(input.prompt)
      const turn = turns[Math.min(index, turns.length - 1)]
      index += 1
      return {
        text: turn.text ?? "",
        structured: turn.structured,
        error: turn.errorName ? "Model did not produce structured output" : undefined,
        errorName: turn.errorName,
        sessionID: "child",
      }
    }
    return { runner, sent }
  }

  const SCHEMA = { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] }

  it("scrapes valid JSON out of the prose the error still carries", async () => {
    // OpenCode returns the model's prose alongside the error; the prompt
    // instruction usually made that prose valid JSON already.
    const { runner, sent } = runnerWith([
      { text: '{"answer":"recovered from text"}', errorName: "StructuredOutputError" },
    ])
    const result = await runWorkflowScript({
      script: `export const meta = { name: 'm', description: 'd' }\nreturn await agent('go', { schema: ${JSON.stringify(SCHEMA)} })`,
      runner,
      defaultAgent: "general",
    })
    expect(result.value).toEqual({ answer: "recovered from text" })
    expect(sent).toHaveLength(1)
  })

  it("spends its schema retries instead of returning null on the first miss", async () => {
    const { runner, sent } = runnerWith([
      { text: "sorry, I cannot", errorName: "StructuredOutputError" },
      { text: "still prose", errorName: "StructuredOutputError" },
      { structured: { answer: "finally" } },
    ])
    const result = await runWorkflowScript({
      script: `export const meta = { name: 'm', description: 'd' }\nreturn await agent('go', { schema: ${JSON.stringify(SCHEMA)} })`,
      runner,
      defaultAgent: "general",
      schemaRetries: 2,
    })
    expect(result.value).toEqual({ answer: "finally" })
    expect(sent).toHaveLength(3)
  })

  it("still returns null for a genuinely failed call", async () => {
    const { runner } = runnerWith([{ errorName: "APIError" }])
    const result = await runWorkflowScript({
      script: `export const meta = { name: 'm', description: 'd' }\nreturn await agent('go', { schema: ${JSON.stringify(SCHEMA)} })`,
      runner,
      defaultAgent: "general",
      schemaRetries: 0,
    })
    expect(result.value).toBeNull()
  })
})

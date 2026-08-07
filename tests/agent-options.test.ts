import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { runWorkflowScript, WorkflowScriptError } from "../src/script/engine.js"
import { createFakeRunner } from "../src/runtime/fake.js"
import { createSdkRunner, type OpencodeClientLike } from "../src/runtime/sdk.js"
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
  variants?: Map<string, string[]>,
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
    async listModelVariants(model) {
      return variants?.get(model)
    },
  }
}

function withMeta(body: string): string {
  return `export const meta = { name: 'opts-test', description: 'agent option test' }\n${body}`
}

const tempDirs: string[] = []

async function tempWorkingDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "open-workflows-opts-"))
  tempDirs.push(directory)
  return directory
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const directory = tempDirs.pop()
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {})
  }
})

describe("agent() rejects an isolation OpenCode cannot honor", () => {
  it("rejects 'remote' and names the supported value", async () => {
    const runner = scriptedRunner(() => "done")
    const failure = await runWorkflowScript({
      script: withMeta("return await agent('do it', { isolation: 'remote' })"),
      runner,
      defaultAgent: "general",
    }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(WorkflowScriptError)
    const scriptError = failure as WorkflowScriptError
    expect(scriptError.message).toContain('"remote"')
    expect(scriptError.message).toContain('"worktree"')
    // A real rejection spawns nothing; an error thrown later would not.
    expect(runner.created).toHaveLength(0)
    expect(runner.runs).toHaveLength(0)
    // Pins the check ahead of the seq assignment, so a rejected call neither
    // burns a lifetime-cap slot nor shifts resume-replay numbering.
    expect(scriptError.partial.agentCount).toBe(0)
  })

  it("rejects a typo rather than silently running unisolated", async () => {
    const runner = scriptedRunner(() => "done")
    const failure = await runWorkflowScript({
      script: withMeta("return await agent('do it', { isolation: 'worktre' })"),
      runner,
      defaultAgent: "general",
    }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(WorkflowScriptError)
    expect((failure as WorkflowScriptError).message).toContain('"worktre"')
    expect(runner.runs).toHaveLength(0)
  })

  it("fails the run from inside parallel() instead of degrading to a null item", async () => {
    const runner = scriptedRunner(() => "done")
    await expect(
      runWorkflowScript({
        script: withMeta("return await parallel([() => agent('a', { isolation: 'remote' })])"),
        runner,
        defaultAgent: "general",
      }),
    ).rejects.toThrow(/unsupported isolation/)
    expect(runner.runs).toHaveLength(0)
  })

  it("fails the run from inside pipeline() instead of degrading to a null item", async () => {
    const runner = scriptedRunner(() => "done")
    await expect(
      runWorkflowScript({
        script: withMeta(
          "return await pipeline(['x'], (item) => agent(item, { isolation: 'remote' }))",
        ),
        runner,
        defaultAgent: "general",
      }),
    ).rejects.toThrow(/unsupported isolation/)
    expect(runner.runs).toHaveLength(0)
  })

  it("fails the run when a nested workflow inside parallel() uses a bad isolation", async () => {
    const workingDirectory = await tempWorkingDirectory()
    const childPath = join(workingDirectory, "child.js")
    await writeFile(
      childPath,
      "export const meta = { name: 'child', description: 'child' }\n" +
        "return await agent('nested', { isolation: 'remote' })",
      "utf8",
    )
    const runner = scriptedRunner(() => "done")
    // The child's failure arrives wrapped in a WorkflowScriptError, so this
    // only holds if the wrapper's cause is inspected.
    await expect(
      runWorkflowScript({
        script: withMeta(
          `return await parallel([() => workflow({ scriptPath: ${JSON.stringify(childPath)} })])`,
        ),
        runner,
        defaultAgent: "general",
      }),
    ).rejects.toThrow(/unsupported isolation/)
    expect(runner.runs).toHaveLength(0)
  })

  it("leaves an omitted or undefined isolation alone", async () => {
    for (const body of [
      "return await agent('do it')",
      "return await agent('do it', { isolation: undefined })",
    ]) {
      const runner = scriptedRunner(() => "done")
      const result = await runWorkflowScript({
        script: withMeta(body),
        runner,
        defaultAgent: "general",
      })
      expect(result.value).toBe("done")
      expect(runner.runs).toHaveLength(1)
    }
  })
})

describe("agent() effort maps onto an OpenCode model variant", () => {
  it("rejects an unknown effort and names every legal level", async () => {
    for (const literal of ["'ultra'", "42"]) {
      const runner = scriptedRunner(() => "ok")
      const failure = await runWorkflowScript({
        script: withMeta(`return await agent('x', { effort: ${literal} })`),
        runner,
        defaultAgent: "general",
      }).catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(WorkflowScriptError)
      const text = (failure as WorkflowScriptError).message
      for (const level of ["low", "medium", "high", "xhigh", "max"]) {
        expect(text).toContain(`"${level}"`)
      }
      expect(runner.runs).toHaveLength(0)
    }
  })

  it("accepts every legal level and sends it as the variant", async () => {
    for (const level of ["low", "medium", "high", "xhigh", "max"]) {
      const runner = scriptedRunner(() => "ok")
      await runWorkflowScript({
        script: withMeta(`await agent('x', { effort: '${level}' })`),
        runner,
        defaultAgent: "general",
      })
      expect(runner.runs[0]?.variant).toBe(level)
    }
  })

  it("sends no variant when effort is omitted", async () => {
    const runner = scriptedRunner(() => "ok")
    await runWorkflowScript({
      script: withMeta("await agent('x')"),
      runner,
      defaultAgent: "general",
    })
    expect(runner.runs[0]?.variant).toBeUndefined()
  })

  it("passes the effort through untouched when the model exposes it", async () => {
    const runner = scriptedRunner(
      () => "ok",
      new Map([["anthropic/claude-opus-4-6", ["low", "medium", "high", "max"]]]),
    )
    const result = await runWorkflowScript({
      script: withMeta("await agent('x', { effort: 'medium' })"),
      runner,
      defaultAgent: "general",
      model: "anthropic/claude-opus-4-6",
    })
    expect(runner.runs[0]?.variant).toBe("medium")
    expect(result.logs).toEqual([])
  })

  it("downgrades to the nearest variant and says so", async () => {
    const runner = scriptedRunner(
      () => "ok",
      new Map([["anthropic/claude-opus-4-6", ["low", "medium", "high", "max"]]]),
    )
    const result = await runWorkflowScript({
      script: withMeta("await agent('x', { effort: 'xhigh' })"),
      runner,
      defaultAgent: "general",
      model: "anthropic/claude-opus-4-6",
    })
    expect(runner.runs[0]?.variant).toBe("max")
    expect(result.logs.some((entry) => entry.includes('has no "xhigh" variant; using "max"'))).toBe(
      true,
    )
  })

  it("upgrades a low effort on a model that only offers high and max", async () => {
    // The common case on OpenCode 1.15: most Anthropic models expose only these
    // two, so a 'low' request is a real semantic surprise worth logging.
    const runner = scriptedRunner(
      () => "ok",
      new Map([["anthropic/claude-sonnet-4-5", ["high", "max"]]]),
    )
    const result = await runWorkflowScript({
      script: withMeta("await agent('x', { effort: 'low' })"),
      runner,
      defaultAgent: "general",
      model: "anthropic/claude-sonnet-4-5",
    })
    expect(runner.runs[0]?.variant).toBe("high")
    expect(result.logs.some((entry) => entry.includes('has no "low" variant; using "high"'))).toBe(
      true,
    )
  })

  it("drops the variant and says so when the model has none", async () => {
    const runner = scriptedRunner(() => "ok", new Map([["x/y", []]]))
    const result = await runWorkflowScript({
      script: withMeta("await agent('x', { effort: 'high' })"),
      runner,
      defaultAgent: "general",
      model: "x/y",
    })
    expect(runner.runs[0]?.variant).toBeUndefined()
    expect(result.logs.some((entry) => entry.includes('effort "high" ignored'))).toBe(true)
  })

  it("sends the effort unchecked when the catalogue is unknown", async () => {
    const runner = scriptedRunner(() => "ok", new Map())
    const result = await runWorkflowScript({
      script: withMeta("await agent('x', { effort: 'xhigh' })"),
      runner,
      defaultAgent: "general",
      model: "mystery/model",
    })
    expect(runner.runs[0]?.variant).toBe("xhigh")
    expect(result.logs).toEqual([])
  })

  it("works against a runner that cannot list variants at all", async () => {
    const runner = scriptedRunner(() => "ok")
    delete (runner as { listModelVariants?: unknown }).listModelVariants
    await runWorkflowScript({
      script: withMeta("await agent('x', { effort: 'max' })"),
      runner,
      defaultAgent: "general",
      model: "mystery/model",
    })
    expect(runner.runs[0]?.variant).toBe("max")
  })

  it("keeps the variant on a schema retry", async () => {
    const runner = scriptedRunner((_input, index) =>
      index === 0 ? "not json" : '{"bugs": []}',
    )
    await runWorkflowScript({
      script: withMeta(
        "await agent('x', { effort: 'high', schema: { type: 'object', required: ['bugs'] } })",
      ),
      runner,
      defaultAgent: "general",
    })
    expect(runner.runs).toHaveLength(2)
    expect(runner.runs.map((run) => run.variant)).toEqual(["high", "high"])
  })

  it("re-runs live on resume when the effort changed", async () => {
    const workingDirectory = await tempWorkingDirectory()
    const script = (effort: string): string =>
      withMeta(`return await agent('do it', { effort: '${effort}' })`)
    const first = await runWorkflowScript({
      script: script("high"),
      runner: scriptedRunner(() => "recorded"),
      defaultAgent: "general",
      workingDirectory,
    })

    const changed = scriptedRunner(() => "live")
    const resumed = await runWorkflowScript({
      script: script("max"),
      runner: changed,
      defaultAgent: "general",
      workingDirectory,
      resumeFromRunId: first.runId,
    })
    // A different reasoning budget is a different request, so the journal entry
    // must not be replayed.
    expect(resumed.value).toBe("live")
    expect(changed.runs).toHaveLength(1)

    const unchanged = scriptedRunner(() => "must never run")
    const replayed = await runWorkflowScript({
      script: script("high"),
      runner: unchanged,
      defaultAgent: "general",
      workingDirectory,
      resumeFromRunId: first.runId,
    })
    expect(replayed.value).toBe("recorded")
    expect(unchanged.runs).toHaveLength(0)
  })
})

describe("fake runner variant support", () => {
  it("reports configured variants and undefined for unknown models", async () => {
    const runner = createFakeRunner({
      defaultResponse: "ok",
      variants: new Map([["anthropic/claude-opus-4-6", ["low", "high"]]]),
    })
    expect(await runner.listModelVariants?.("anthropic/claude-opus-4-6")).toEqual(["low", "high"])
    expect(await runner.listModelVariants?.("other/model")).toBeUndefined()
  })

  it("records the variant each call was run with", async () => {
    const runner = createFakeRunner({ defaultResponse: "ok" })
    const session = await runner.createChildSession({ title: "t", agent: "general" })
    await runner.runChildSession({
      sessionID: session.sessionID,
      agent: "general",
      prompt: "go",
      variant: "max",
    })
    expect(runner.runs[0]?.variant).toBe("max")
  })
})

describe("SdkRunner variant plumbing", () => {
  function clientWithPrompt(
    capture: (body: Record<string, unknown>) => void,
    providers?: { data?: unknown; error?: unknown; onCall?: () => void },
  ): OpencodeClientLike {
    return {
      session: {
        create: async () => ({ data: { id: "s-1" } }),
        prompt: async (opts: { body: Record<string, unknown> }) => {
          capture(opts.body)
          return { data: { info: {}, parts: [] } }
        },
        delete: async () => ({ data: true }),
      },
      config: {
        providers: async () => {
          providers?.onCall?.()
          if (providers?.error) return { error: providers.error }
          return { data: providers?.data }
        },
      },
    } as unknown as OpencodeClientLike
  }

  it("puts the variant on the prompt body, and omits it when unset", async () => {
    const bodies: Array<Record<string, unknown>> = []
    const runner = createSdkRunner(
      clientWithPrompt((body) => bodies.push(body)),
      "parent",
    )
    await runner.runChildSession({
      sessionID: "s-1",
      agent: "general",
      prompt: "go",
      variant: "high",
    })
    await runner.runChildSession({ sessionID: "s-1", agent: "general", prompt: "go" })
    expect(bodies[0]?.variant).toBe("high")
    expect(bodies[1]).not.toHaveProperty("variant")
  })

  it("indexes variants from /config/providers and fetches the catalogue once", async () => {
    let calls = 0
    const runner = createSdkRunner(
      clientWithPrompt(() => {}, {
        onCall: () => {
          calls += 1
        },
        data: {
          providers: [
            {
              id: "opencode",
              models: {
                "deepseek-v4-flash-free": { variants: { low: {}, medium: {}, high: {}, max: {} } },
              },
            },
            { id: "anthropic", models: { "claude-haiku-4-5": {} } },
          ],
        },
      }),
      "parent",
    )
    expect(await runner.listModelVariants?.("opencode/deepseek-v4-flash-free")).toEqual([
      "low",
      "medium",
      "high",
      "max",
    ])
    // A model with no variants is known-empty, which is different from unknown.
    expect(await runner.listModelVariants?.("anthropic/claude-haiku-4-5")).toEqual([])
    expect(await runner.listModelVariants?.("nobody/nothing")).toBeUndefined()
    expect(calls).toBe(1)
  })

  it("reports an unreadable catalogue as unknown rather than failing", async () => {
    const runner = createSdkRunner(
      clientWithPrompt(() => {}, { error: { message: "providers unavailable" } }),
      "parent",
    )
    expect(await runner.listModelVariants?.("anything/at-all")).toBeUndefined()
  })
})

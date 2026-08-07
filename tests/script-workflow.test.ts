import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
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

function withMeta(body: string, name = "test-wf"): string {
  return `export const meta = { name: '${name}', description: 'test workflow' }\n${body}`
}

const tempDirs: string[] = []

async function tempScript(name: string, body: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "open-workflows-child-"))
  tempDirs.push(dir)
  const path = join(dir, `${name}.js`)
  await writeFile(path, withMeta(body, name), "utf8")
  return path
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("workflow() nesting", () => {
  it("runs a child from scriptPath, passes args, and returns its value", async () => {
    const runner = scriptedRunner(() => "child agent says hi")
    const childPath = await tempScript(
      "child-wf",
      [
        "phase('Child phase')",
        "const text = await agent('child task', { label: 'child-agent' })",
        "return { text, doubled: args.n * 2 }",
      ].join("\n"),
    )
    const starts: Array<{ id: number; label: string; phase?: string }> = []
    const result = await runWorkflowScript({
      script: withMeta(
        [
          "phase('Parent phase')",
          "await agent('parent task', { label: 'parent-agent' })",
          `const child = await workflow({ scriptPath: ${JSON.stringify(childPath)} }, { n: 21 })`,
          "return child",
        ].join("\n"),
      ),
      runner,
      defaultAgent: "general",
      events: { onAgentStart: (event) => starts.push(event) },
    })
    expect(result.value).toEqual({ text: "child agent says hi", doubled: 42 })
    // Child agents share the parent's lifetime counter, and their phases are
    // scoped under a "> name" group so a child phase() cannot rewrite the
    // parent's roadmap.
    expect(starts).toEqual([
      { id: 1, label: "parent-agent", phase: "Parent phase" },
      { id: 2, label: "child-agent", phase: "> child-wf · Child phase" },
    ])
    expect(result.agentCount).toBe(2)
    expect(result.sessionIDs).toEqual(["s-1", "s-2"])
    // The child's phases stay its own; the parent roadmap keeps only parent phases.
    expect(result.phases).toEqual(["Parent phase"])
  })

  it("counts child token spend against the parent budget ceiling", async () => {
    const runner = scriptedRunner(() => ({ text: "ok", tokens: { output: 60 } }))
    const childPath = await tempScript("spender", "await agent('spend tokens')\nreturn 'spent'")
    const failure = await runWorkflowScript({
      script: withMeta(
        [
          `await workflow({ scriptPath: ${JSON.stringify(childPath)} })`,
          "if (budget.spent() !== 60) throw new Error('budget not shared: ' + budget.spent())",
          "await agent('parent runs after ceiling')",
        ].join("\n"),
      ),
      runner,
      defaultAgent: "general",
      budgetTokens: 50,
    }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(WorkflowScriptError)
    expect((failure as WorkflowScriptError).message).toMatch(/Token budget exhausted: spent 60 of 50/)
    expect(runner.runs).toHaveLength(1)
  })

  it("counts child agents against the shared lifetime cap", async () => {
    const runner = scriptedRunner(() => "ok")
    const childPath = await tempScript(
      "two-agents",
      "await agent('one')\nawait agent('two')\nreturn 'done'",
    )
    const failure = await runWorkflowScript({
      script: withMeta(
        [
          `await workflow({ scriptPath: ${JSON.stringify(childPath)} })`,
          "await agent('parent third agent')",
        ].join("\n"),
      ),
      runner,
      defaultAgent: "general",
      maxAgents: 2,
    }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(WorkflowScriptError)
    expect((failure as WorkflowScriptError).message).toMatch(/2-agent lifetime cap/)
    expect(runner.runs).toHaveLength(2)
  })

  it("throws when a child nests another workflow() call", async () => {
    const runner = scriptedRunner(() => "ok")
    const grandchildPath = await tempScript("grandchild", "return 'too deep'")
    const childPath = await tempScript(
      "nester",
      `return await workflow({ scriptPath: ${JSON.stringify(grandchildPath)} })`,
    )
    await expect(
      runWorkflowScript({
        script: withMeta(`return await workflow({ scriptPath: ${JSON.stringify(childPath)} })`),
        runner,
        defaultAgent: "general",
      }),
    ).rejects.toThrow(/Nesting is one level only/)
  })

  it("throws on an unknown saved workflow name", async () => {
    const runner = scriptedRunner(() => "ok")
    await expect(
      runWorkflowScript({
        script: withMeta("await workflow('no-such-saved-workflow-xyz')"),
        runner,
        defaultAgent: "general",
      }),
    ).rejects.toThrow(/Unknown workflow "no-such-saved-workflow-xyz"/)
  })

  it("resolves a saved workflow name from <workingDirectory>/.opencode/workflows", async () => {
    const runner = scriptedRunner(() => "ok")
    const workingDirectory = await mkdtemp(join(tmpdir(), "open-workflows-wd-"))
    tempDirs.push(workingDirectory)
    const workflowsDir = join(workingDirectory, ".opencode", "workflows")
    await mkdir(workflowsDir, { recursive: true })
    await writeFile(join(workflowsDir, "saved-child.js"), withMeta("return args.word.toUpperCase()", "saved-child"), "utf8")
    const result = await runWorkflowScript({
      script: withMeta("return await workflow('saved-child', { word: 'quiet' })"),
      runner,
      defaultAgent: "general",
      workingDirectory,
    })
    expect(result.value).toBe("QUIET")
  })

  it("throws on an unreadable scriptPath", async () => {
    const runner = scriptedRunner(() => "ok")
    await expect(
      runWorkflowScript({
        script: withMeta("await workflow({ scriptPath: '/definitely/missing/child.js' })"),
        runner,
        defaultAgent: "general",
      }),
    ).rejects.toThrow(/could not read the script at \/definitely\/missing\/child\.js/)
  })

  it("names the saved workflows available when the name is unknown", async () => {
    // This is what makes meta.whenToUse load-bearing rather than a field the
    // parser validates and nothing reads.
    const workingDirectory = await mkdtemp(join(tmpdir(), "open-workflows-list-"))
    tempDirs.push(workingDirectory)
    const workflowsDir = join(workingDirectory, ".opencode", "workflows")
    await mkdir(workflowsDir, { recursive: true })
    await writeFile(
      join(workflowsDir, "triage.js"),
      "export const meta = { name: 'triage', description: 'd', whenToUse: 'when CI is red' }\nreturn 1",
      "utf8",
    )
    await writeFile(join(workflowsDir, "broken.js"), "not a workflow at all", "utf8")
    const failure = await runWorkflowScript({
      script: withMeta("await workflow('does-not-exist')"),
      runner: scriptedRunner(() => "ok"),
      defaultAgent: "general",
      workingDirectory,
    }).catch((error: unknown) => error)
    const message = (failure as Error).message
    expect(message).toContain('"triage" (when CI is red)')
    // An unparseable file is skipped rather than failing the listing.
    expect(message).not.toContain("broken")
  })

  it("groups a child workflow's logs under its name", async () => {
    const logs: string[] = []
    const childPath = await tempScript("noisy", "log('child said this')\nreturn 1")
    await runWorkflowScript({
      script: withMeta(
        [
          "log('parent said this')",
          `await workflow({ scriptPath: ${JSON.stringify(childPath)} })`,
        ].join("\n"),
      ),
      runner: scriptedRunner(() => "ok"),
      defaultAgent: "general",
      events: { onLog: (entry) => logs.push(entry) },
    })
    expect(logs).toEqual(["parent said this", "> noisy: child said this"])
  })

  it("rejects workflow() calls without a name or scriptPath", async () => {
    const runner = scriptedRunner(() => "ok")
    await expect(
      runWorkflowScript({
        script: withMeta("await workflow(42)"),
        runner,
        defaultAgent: "general",
      }),
    ).rejects.toThrow(/requires a saved workflow name or \{ scriptPath \}/)
  })
})

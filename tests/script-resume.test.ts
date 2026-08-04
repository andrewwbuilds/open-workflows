import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { runWorkflowScript, WorkflowScriptError } from "../src/script/engine.js"
import {
  generateRunId,
  hashAgentCall,
  hashScript,
  journalPath,
  type JournalEntry,
  type JournalHeader,
} from "../src/script/journal.js"
import { createWorkflowScriptTool } from "../src/tool.js"
import type { OpencodeClientLike } from "../src/runtime/sdk.js"
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

function withMeta(body: string): string {
  return `export const meta = { name: 'test-wf', description: 'test workflow' }\n${body}`
}

const tempDirs: string[] = []

async function tempWorkingDirectory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "open-workflows-resume-"))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function readJournal(
  workingDirectory: string,
  runId: string,
): Promise<{ header: JournalHeader; entries: JournalEntry[] }> {
  const raw = await readFile(journalPath(workingDirectory, runId), "utf8")
  const lines = raw.trim().split("\n")
  return {
    header: JSON.parse(lines[0]!) as JournalHeader,
    entries: lines.slice(1).map((line) => JSON.parse(line) as JournalEntry),
  }
}

const TWO_AGENT_SCRIPT = withMeta(
  [
    "phase('Scan')",
    "const first = await agent('first task', { label: 'one' })",
    "const second = await agent('second task', { label: 'two' })",
    "return [first, second]",
  ].join("\n"),
)

function respondByPrompt(input: RunChildSessionInput): string {
  if (input.prompt.includes("first")) return "alpha"
  if (input.prompt.includes("second")) return "beta"
  if (input.prompt.includes("third")) return "gamma"
  return "other"
}

describe("workflow run journaling", () => {
  it("assigns a wf_ runId and journals header plus one line per agent() call", async () => {
    const workingDirectory = await tempWorkingDirectory()
    const runner = scriptedRunner(respondByPrompt)
    const result = await runWorkflowScript({
      script: TWO_AGENT_SCRIPT,
      runner,
      defaultAgent: "general",
      workingDirectory,
    })
    expect(result.runId).toMatch(/^wf_[0-9a-f]+$/)
    expect(result.value).toEqual(["alpha", "beta"])

    const { header, entries } = await readJournal(workingDirectory, result.runId)
    expect(header.runId).toBe(result.runId)
    expect(header.scriptHash).toBe(hashScript(TWO_AGENT_SCRIPT))
    expect(header.meta.name).toBe("test-wf")
    expect(entries).toEqual([
      {
        seq: 1,
        hash: hashAgentCall("first task", { label: "one" }),
        label: "one",
        phase: "Scan",
        result: "alpha",
      },
      {
        seq: 2,
        hash: hashAgentCall("second task", { label: "two" }),
        label: "two",
        phase: "Scan",
        result: "beta",
      },
    ])
  })

  it("journals failed agent() calls as null results", async () => {
    const workingDirectory = await tempWorkingDirectory()
    const runner = scriptedRunner(() => ({ text: "", error: "boom" }))
    const result = await runWorkflowScript({
      script: withMeta("return await agent('doomed task')"),
      runner,
      defaultAgent: "general",
      workingDirectory,
    })
    expect(result.value).toBeNull()
    const { entries } = await readJournal(workingDirectory, result.runId)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.result).toBeNull()
  })

  it("honors a caller-supplied runId and flushes the journal on script failure", async () => {
    const workingDirectory = await tempWorkingDirectory()
    const runner = scriptedRunner(respondByPrompt)
    const runId = generateRunId()
    const failure = await runWorkflowScript({
      script: withMeta(
        [
          "await agent('first task')",
          "throw new Error('script exploded')",
        ].join("\n"),
      ),
      runner,
      defaultAgent: "general",
      workingDirectory,
      runId,
    }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(WorkflowScriptError)
    expect((failure as WorkflowScriptError).partial.runId).toBe(runId)
    const { entries } = await readJournal(workingDirectory, runId)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.result).toBe("alpha")
  })
})

describe("workflow resume replay", () => {
  it("replays an identical script fully from cache with zero child sessions", async () => {
    const workingDirectory = await tempWorkingDirectory()
    const firstRunner = scriptedRunner(respondByPrompt)
    const first = await runWorkflowScript({
      script: TWO_AGENT_SCRIPT,
      runner: firstRunner,
      defaultAgent: "general",
      workingDirectory,
    })

    const resumeRunner = scriptedRunner(() => "must never run")
    const resumed = await runWorkflowScript({
      script: TWO_AGENT_SCRIPT,
      runner: resumeRunner,
      defaultAgent: "general",
      workingDirectory,
      resumeFromRunId: first.runId,
    })
    expect(resumeRunner.created).toHaveLength(0)
    expect(resumeRunner.runs).toHaveLength(0)
    expect(resumed.value).toEqual(first.value)
    expect(resumed.agentCount).toBe(2)
    expect(resumed.runId).not.toBe(first.runId)

    // The resumed run journals the replayed calls too, so it is resumable.
    const { entries } = await readJournal(workingDirectory, resumed.runId)
    expect(entries.map((entry) => entry.result)).toEqual(["alpha", "beta"])
  })

  it("replays only the unchanged prefix when a later prompt is edited", async () => {
    const workingDirectory = await tempWorkingDirectory()
    const script = withMeta(
      [
        "const a = await agent('first task')",
        "const b = await agent('second task')",
        "const c = await agent('third task')",
        "return [a, b, c]",
      ].join("\n"),
    )
    const first = await runWorkflowScript({
      script,
      runner: scriptedRunner(respondByPrompt),
      defaultAgent: "general",
      workingDirectory,
    })
    expect(first.value).toEqual(["alpha", "beta", "gamma"])

    const editedScript = withMeta(
      [
        "const a = await agent('first task')",
        "const b = await agent('second task EDITED')",
        "const c = await agent('third task')",
        "return [a, b, c]",
      ].join("\n"),
    )
    const resumeRunner = scriptedRunner((input) => `live:${respondByPrompt(input)}`)
    const resumed = await runWorkflowScript({
      script: editedScript,
      runner: resumeRunner,
      defaultAgent: "general",
      workingDirectory,
      resumeFromRunId: first.runId,
    })
    // First call comes from the journal; the edited second call mismatches and
    // switches the run permanently to live, so the unchanged third runs live too.
    expect(resumed.value).toEqual(["alpha", "live:beta", "live:gamma"])
    expect(resumeRunner.runs).toHaveLength(2)
    expect(resumeRunner.runs[0]?.prompt).toContain("second task EDITED")
    expect(resumeRunner.runs[1]?.prompt).toContain("third task")
  })

  it("runs live for seqs beyond the journal", async () => {
    const workingDirectory = await tempWorkingDirectory()
    const first = await runWorkflowScript({
      script: withMeta("return await agent('first task')"),
      runner: scriptedRunner(respondByPrompt),
      defaultAgent: "general",
      workingDirectory,
    })
    const resumeRunner = scriptedRunner((input) => `live:${respondByPrompt(input)}`)
    const resumed = await runWorkflowScript({
      script: withMeta(
        [
          "const a = await agent('first task')",
          "const b = await agent('second task')",
          "return [a, b]",
        ].join("\n"),
      ),
      runner: resumeRunner,
      defaultAgent: "general",
      workingDirectory,
      resumeFromRunId: first.runId,
    })
    expect(resumed.value).toEqual(["alpha", "live:beta"])
    expect(resumeRunner.runs).toHaveLength(1)
  })

  it("skips the token budget for cached replays but still fires events", async () => {
    const workingDirectory = await tempWorkingDirectory()
    const first = await runWorkflowScript({
      script: TWO_AGENT_SCRIPT,
      runner: scriptedRunner((input) => ({ text: respondByPrompt(input), tokens: { output: 40 } })),
      defaultAgent: "general",
      workingDirectory,
    })
    expect(first.tokensSpent).toBe(80)

    const events: string[] = []
    const resumed = await runWorkflowScript({
      script: TWO_AGENT_SCRIPT,
      runner: scriptedRunner(() => "must never run"),
      defaultAgent: "general",
      workingDirectory,
      resumeFromRunId: first.runId,
      // A live rerun would exhaust this budget on the first call's spend.
      budgetTokens: 10,
      events: {
        onAgentStart: (event) => events.push(`start:${event.label}@${event.phase}`),
        onAgentEnd: (event) => events.push(`end:${event.label}@${event.phase}:${event.ok}`),
      },
    })
    expect(resumed.value).toEqual(["alpha", "beta"])
    expect(resumed.tokensSpent).toBe(0)
    expect(events).toEqual([
      "start:one@Scan",
      "end:one@Scan:true",
      "start:two@Scan",
      "end:two@Scan:true",
    ])
  })

  it("counts cached replays toward the agent lifetime cap", async () => {
    const workingDirectory = await tempWorkingDirectory()
    const first = await runWorkflowScript({
      script: TWO_AGENT_SCRIPT,
      runner: scriptedRunner(respondByPrompt),
      defaultAgent: "general",
      workingDirectory,
    })
    await expect(
      runWorkflowScript({
        script: TWO_AGENT_SCRIPT,
        runner: scriptedRunner(() => "must never run"),
        defaultAgent: "general",
        workingDirectory,
        resumeFromRunId: first.runId,
        maxAgents: 1,
      }),
    ).rejects.toThrow(/lifetime cap/)
  })

  it("throws when the resume journal does not exist", async () => {
    const workingDirectory = await tempWorkingDirectory()
    await expect(
      runWorkflowScript({
        script: TWO_AGENT_SCRIPT,
        runner: scriptedRunner(respondByPrompt),
        defaultAgent: "general",
        workingDirectory,
        resumeFromRunId: "wf_doesnotexist",
      }),
    ).rejects.toThrow(/No journal found for run "wf_doesnotexist"/)
  })

  it("requires a working directory to resume", async () => {
    await expect(
      runWorkflowScript({
        script: TWO_AGENT_SCRIPT,
        runner: scriptedRunner(respondByPrompt),
        defaultAgent: "general",
        resumeFromRunId: "wf_doesnotexist",
      }),
    ).rejects.toThrow(/resumeFromRunId requires a working directory/)
  })

  it("still assigns a runId when no working directory is configured", async () => {
    const runner = scriptedRunner(respondByPrompt)
    const result = await runWorkflowScript({
      script: withMeta("return await agent('first task')"),
      runner,
      defaultAgent: "general",
    })
    expect(result.runId).toMatch(/^wf_[0-9a-f]+$/)
  })
})

describe("hashAgentCall", () => {
  it("ignores label but is sensitive to prompt and other options", () => {
    expect(hashAgentCall("p", { label: "a" })).toBe(hashAgentCall("p", { label: "b" }))
    expect(hashAgentCall("p", {})).not.toBe(hashAgentCall("q", {}))
    expect(hashAgentCall("p", { model: "x/y" })).not.toBe(hashAgentCall("p", {}))
  })
})

describe("createWorkflowScriptTool resume surface", () => {
  function fakeClient(reply: string): OpencodeClientLike {
    let counter = 0
    return {
      session: {
        create: async () => {
          counter += 1
          return { data: { id: `s-${counter}` } }
        },
        prompt: async (opts: { path: { id: string } }) => ({
          data: {
            info: { tokens: { input: 0, output: 0 } },
            parts: [{ type: "text", text: reply, id: "p", sessionID: opts.path.id, messageID: "m" }],
          },
        }),
        delete: async () => ({ data: true }),
      },
    } as unknown as OpencodeClientLike
  }

  function toolContext(directory: string) {
    return {
      sessionID: "parent",
      messageID: "msg",
      agent: "build",
      directory,
      worktree: directory,
      abort: new AbortController().signal,
      metadata: () => undefined,
      ask: () => undefined,
    }
  }

  it("includes the Run ID line in success and failure results", async () => {
    const directory = await tempWorkingDirectory()
    const workflowTool = createWorkflowScriptTool({
      client: fakeClient("ok"),
      pluginOptions: {},
    })
    const execute = (workflowTool as unknown as {
      execute: (a: unknown, c: unknown) => Promise<string>
    }).execute

    const success = await execute(
      { script: withMeta("return await agent('first task')") },
      toolContext(directory),
    )
    expect(success).toMatch(/Run ID: wf_[0-9a-f]+ - pass resumeFromRunId to resume/)

    const failure = await execute(
      { script: withMeta("throw new Error('kaboom')") },
      toolContext(directory),
    )
    expect(failure).toContain("kaboom")
    expect(failure).toMatch(/Run ID: wf_[0-9a-f]+ - pass resumeFromRunId to resume/)
  })
})

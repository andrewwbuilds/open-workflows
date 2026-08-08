import { mkdtemp, rm } from "node:fs/promises"
import { readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { runWorkflowScript } from "../src/script/engine.js"
import { createReplayState, hashArgs, journalPath, loadJournal } from "../src/script/journal.js"
import type {
  RunChildSessionInput,
  RunChildSessionResult,
  SessionRunner,
} from "../src/runtime/types.js"

interface ScriptedRunner extends SessionRunner {
  runs: RunChildSessionInput[]
}

function scriptedRunner(
  respond: (input: RunChildSessionInput) => Partial<RunChildSessionResult>,
  delays: Map<string, number> = new Map(),
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
      runs.push(input)
      const delay = [...delays.entries()].find(([key]) => input.prompt.includes(key))?.[1]
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay))
      return { text: "", sessionID: input.sessionID, ...respond(input) }
    },
    async deleteSession() {},
  }
}

function withMeta(body: string): string {
  return `export const meta = { name: 'det', description: 'determinism' }\n${body}`
}

const tempDirs: string[] = []

async function tempWorkingDirectory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "open-workflows-det-"))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const echo = (input: RunChildSessionInput): Partial<RunChildSessionResult> => ({
  text: `answer:${input.prompt}`,
})

describe("resume replays concurrent runs with a full cache hit", () => {
  // seq is assigned when agent() is invoked, so under parallel()/pipeline() it
  // follows real completion timing. Keying replay on it made an unedited script
  // re-run agents purely because two lanes finished in a different order.
  const CONCURRENT_SCRIPT = withMeta(
    [
      "const out = await pipeline(['slow', 'fast'],",
      "  async (item) => agent('stage1 ' + item),",
      "  async (prev, item) => agent('stage2 ' + item),",
      ")",
      "return out",
    ].join("\n"),
  )

  it("replays every agent when the same script and args run again", async () => {
    const workingDirectory = await tempWorkingDirectory()
    const first = await runWorkflowScript({
      script: CONCURRENT_SCRIPT,
      runner: scriptedRunner(echo, new Map([["slow", 25]])),
      defaultAgent: "general",
      workingDirectory,
      concurrency: 4,
    })
    expect(first.agentCount).toBe(4)

    // Reverse which lane is slow so the invocation order genuinely differs.
    const resumeRunner = scriptedRunner(() => ({ text: "MUST NOT RUN" }), new Map([["fast", 25]]))
    const resumed = await runWorkflowScript({
      script: CONCURRENT_SCRIPT,
      runner: resumeRunner,
      defaultAgent: "general",
      workingDirectory,
      concurrency: 4,
      resumeFromRunId: first.runId,
    })
    expect(resumeRunner.runs).toHaveLength(0)
    expect(resumed.value).toEqual(first.value)
  })

  it("still goes live from the first changed call onward", async () => {
    const workingDirectory = await tempWorkingDirectory()
    const script = (second: string): string =>
      withMeta(
        [
          "const a = await agent('first task')",
          `const b = await agent('${second}')`,
          "const c = await agent('third task')",
          "return [a, b, c]",
        ].join("\n"),
      )
    const first = await runWorkflowScript({
      script: script("second task"),
      runner: scriptedRunner(echo),
      defaultAgent: "general",
      workingDirectory,
    })
    const resumeRunner = scriptedRunner(() => ({ text: "live" }))
    const resumed = await runWorkflowScript({
      script: script("second task EDITED"),
      runner: resumeRunner,
      defaultAgent: "general",
      workingDirectory,
      resumeFromRunId: first.runId,
    })
    // The third call is unchanged but must not replay: its input may depend on
    // the edited one.
    expect(resumed.value).toEqual(["answer:first task", "live", "live"])
    expect(resumeRunner.runs).toHaveLength(2)
  })

  it("consumes duplicate identical calls in journal order", async () => {
    const workingDirectory = await tempWorkingDirectory()
    let counter = 0
    const script = withMeta(
      ["const a = await agent('same')", "const b = await agent('same')", "return [a, b]"].join("\n"),
    )
    const first = await runWorkflowScript({
      script,
      runner: scriptedRunner(() => {
        counter += 1
        return { text: `run-${counter}` }
      }),
      defaultAgent: "general",
      workingDirectory,
    })
    expect(first.value).toEqual(["run-1", "run-2"])

    const resumeRunner = scriptedRunner(() => ({ text: "MUST NOT RUN" }))
    const resumed = await runWorkflowScript({
      script,
      runner: resumeRunner,
      defaultAgent: "general",
      workingDirectory,
      resumeFromRunId: first.runId,
    })
    expect(resumed.value).toEqual(["run-1", "run-2"])
    expect(resumeRunner.runs).toHaveLength(0)
  })
})

// A changed arg is not a reason to refuse: it can only reach a subagent through
// the prompt or the hashed options, so a change that matters is already a hash
// miss and runs live, and a change that does not is a byte-identical call the
// prefix rule is supposed to replay.
describe("resume tolerates a journal written for different args", () => {
  const SCRIPT = withMeta("return await agent('use ' + args.v)")

  it("runs live and replays nothing when the arg changed the prompt", async () => {
    const workingDirectory = await tempWorkingDirectory()
    const first = await runWorkflowScript({
      script: SCRIPT,
      args: { v: 1 },
      runner: scriptedRunner(echo),
      defaultAgent: "general",
      workingDirectory,
    })
    const resumeRunner = scriptedRunner(echo)
    const resumed = await runWorkflowScript({
      script: SCRIPT,
      args: { v: 999 },
      runner: resumeRunner,
      defaultAgent: "general",
      workingDirectory,
      resumeFromRunId: first.runId,
    })
    expect(resumed.value).toBe("answer:use 999")
    expect(resumeRunner.runs).toHaveLength(1)
    expect(resumed.logs.some((line) => /different args/.test(line))).toBe(true)
  })

  it("replays a call the changed arg never touched", async () => {
    // The call is byte-identical, so replaying it is the prefix rule working,
    // not a stale result: the arg only feeds host-side script logic.
    const workingDirectory = await tempWorkingDirectory()
    const script = withMeta("return await agent('fixed prompt')")
    const first = await runWorkflowScript({
      script,
      args: { v: 1 },
      runner: scriptedRunner(echo),
      defaultAgent: "general",
      workingDirectory,
    })
    const resumeRunner = scriptedRunner(() => ({ text: "MUST NOT RUN" }))
    const resumed = await runWorkflowScript({
      script,
      args: { v: 999 },
      runner: resumeRunner,
      defaultAgent: "general",
      workingDirectory,
      resumeFromRunId: first.runId,
    })
    expect(resumed.value).toBe("answer:fixed prompt")
    expect(resumeRunner.runs).toHaveLength(0)
  })

  it("replays the unchanged prefix and goes live from the first changed call", async () => {
    const workingDirectory = await tempWorkingDirectory()
    const script = withMeta("return await parallel(args.files.map((f) => () => agent('review ' + f)))")
    const first = await runWorkflowScript({
      script,
      args: { files: ["a", "b"] },
      runner: scriptedRunner(echo),
      defaultAgent: "general",
      workingDirectory,
    })
    expect(first.value).toEqual(["answer:review a", "answer:review b"])
    const resumeRunner = scriptedRunner(echo)
    const resumed = await runWorkflowScript({
      script,
      args: { files: ["a", "c"] },
      runner: resumeRunner,
      defaultAgent: "general",
      workingDirectory,
      resumeFromRunId: first.runId,
    })
    expect(resumed.value).toEqual(["answer:review a", "answer:review c"])
    expect(resumeRunner.runs).toHaveLength(1)
    expect(resumeRunner.runs[0]?.prompt).toBe("review c")
  })

  it("allows a resume with identical args regardless of key order", async () => {
    const workingDirectory = await tempWorkingDirectory()
    const script = withMeta("return await agent('fixed prompt')")
    const first = await runWorkflowScript({
      script,
      args: { a: 1, b: 2 },
      runner: scriptedRunner(echo),
      defaultAgent: "general",
      workingDirectory,
    })
    const resumeRunner = scriptedRunner(() => ({ text: "MUST NOT RUN" }))
    const resumed = await runWorkflowScript({
      script,
      args: { b: 2, a: 1 },
      runner: resumeRunner,
      defaultAgent: "general",
      workingDirectory,
      resumeFromRunId: first.runId,
    })
    expect(resumed.value).toBe("answer:fixed prompt")
    expect(resumeRunner.runs).toHaveLength(0)
    // The note is only for a genuine mismatch; it must not be noise on the
    // happy path, where it would read as "your resume did not apply".
    expect(resumed.logs.some((line) => /different args/.test(line))).toBe(false)
  })

  it("records the args hash in the journal header", async () => {
    const workingDirectory = await tempWorkingDirectory()
    const result = await runWorkflowScript({
      script: withMeta("return await agent('x')"),
      args: { k: "v" },
      runner: scriptedRunner(echo),
      defaultAgent: "general",
      workingDirectory,
    })
    const { header } = await loadJournal(workingDirectory, result.runId)
    expect(header?.argsHash).toBe(hashArgs({ k: "v" }))
  })
})

describe("createReplayState", () => {
  const entry = (seq: number, hash: string, result: unknown) => ({ seq, hash, label: hash, result })

  it("matches on the call hash regardless of the seq it was journaled under", () => {
    const replay = createReplayState([entry(1, "a", "A"), entry(2, "b", "B")])
    // Reversed invocation order, as a re-ordered parallel() lane produces.
    expect(replay.take("b")).toEqual({ result: "B" })
    expect(replay.take("a")).toEqual({ result: "A" })
  })

  it("consumes each entry once", () => {
    const replay = createReplayState([entry(1, "a", "A")])
    expect(replay.take("a")).toEqual({ result: "A" })
    expect(replay.take("a")).toBeUndefined()
  })

  it("switches permanently to live on the first unknown hash", () => {
    const replay = createReplayState([entry(1, "a", "A"), entry(2, "b", "B")])
    expect(replay.take("a")).toEqual({ result: "A" })
    expect(replay.take("edited")).toBeUndefined()
    expect(replay.take("b")).toBeUndefined()
  })
})

describe("hashArgs", () => {
  it("is key-order insensitive but value sensitive", () => {
    expect(hashArgs({ a: 1, b: [1, { c: 2 }] })).toBe(hashArgs({ b: [1, { c: 2 }], a: 1 }))
    expect(hashArgs({ a: 1 })).not.toBe(hashArgs({ a: 2 }))
    expect(hashArgs(undefined)).not.toBe(hashArgs(null))
  })
})

describe("journals stay out of git", () => {
  it("writes a self-ignoring .gitignore beside the run files", async () => {
    const workingDirectory = await tempWorkingDirectory()
    const result = await runWorkflowScript({
      script: withMeta("return await agent('x')"),
      runner: scriptedRunner(echo),
      defaultAgent: "general",
      workingDirectory,
    })
    const ignore = join(dirname(journalPath(workingDirectory, result.runId)), ".gitignore")
    expect(readFileSync(ignore, "utf8")).toBe("*\n")
  })
})

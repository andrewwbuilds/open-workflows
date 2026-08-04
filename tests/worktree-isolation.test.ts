import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { describe, expect, it } from "vitest"
import { runWorkflowScript } from "../src/script/engine.js"
import { createFakeRunner } from "../src/runtime/fake.js"
import { createSdkRunner, type OpencodeClientLike } from "../src/runtime/sdk.js"
import type {
  CreateChildSessionInput,
  RunChildSessionInput,
  RunChildSessionResult,
  SessionRunner,
} from "../src/runtime/types.js"

const execFileAsync = promisify(execFile)

const gitAvailable = await execFileAsync("git", ["--version"]).then(
  () => true,
  () => false,
)

function withMeta(body: string): string {
  return `export const meta = { name: 'wt-test', description: 'worktree isolation test' }\n${body}`
}

interface RecordingRunner extends SessionRunner {
  created: Array<CreateChildSessionInput & { sessionID: string }>
  runs: RunChildSessionInput[]
}

function recordingRunner(
  onRun?: (input: RunChildSessionInput) => void | Promise<void>,
): RecordingRunner {
  const created: RecordingRunner["created"] = []
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
      runs.push(input)
      await onRun?.(input)
      const result: RunChildSessionResult = { text: "done", sessionID: input.sessionID }
      return result
    },
    async deleteSession() {},
  }
}

async function makeRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "open-workflows-repo-"))
  await execFileAsync("git", ["-C", repo, "init"])
  await execFileAsync("git", ["-C", repo, "config", "user.email", "test@example.com"])
  await execFileAsync("git", ["-C", repo, "config", "user.name", "Test"])
  await execFileAsync("git", ["-C", repo, "config", "commit.gpgsign", "false"])
  await writeFile(join(repo, "file.txt"), "hello\n")
  await execFileAsync("git", ["-C", repo, "add", "."])
  await execFileAsync("git", ["-C", repo, "commit", "-m", "init"])
  return repo
}

async function destroyWorktree(repo: string, worktree: string | undefined): Promise<void> {
  if (!worktree) return
  await execFileAsync("git", ["-C", repo, "worktree", "remove", "--force", worktree]).catch(() => {})
  await rm(worktree, { recursive: true, force: true }).catch(() => {})
}

describe("directory plumbing", () => {
  it("createFakeRunner records the directory passed per call", async () => {
    const runner = createFakeRunner({ defaultResponse: "ok" })
    const session = await runner.createChildSession({
      title: "iso",
      agent: "general",
      directory: "/some/worktree",
    })
    await runner.runChildSession({
      sessionID: session.sessionID,
      agent: "general",
      prompt: "go",
      directory: "/some/worktree",
    })
    expect(runner.created[0]?.directory).toBe("/some/worktree")
    expect(runner.runs[0]?.directory).toBe("/some/worktree")
  })

  it("SdkRunner prefers the per-call directory over its constructor directory", async () => {
    const calls: Array<{ kind: string; query?: { directory?: string } }> = []
    const fakeClient = {
      session: {
        create: async (opts: { query?: { directory?: string } }) => {
          calls.push({ kind: "create", query: opts.query })
          return { data: { id: "s-1" } }
        },
        prompt: async (opts: { query?: { directory?: string } }) => {
          calls.push({ kind: "prompt", query: opts.query })
          return { data: { info: {}, parts: [] } }
        },
        delete: async () => ({ data: true }),
      },
    }
    const runner = createSdkRunner(fakeClient as unknown as OpencodeClientLike, "parent", {
      directory: "/base",
    })
    await runner.createChildSession({ title: "a", agent: "general", directory: "/wt" })
    await runner.runChildSession({ sessionID: "s-1", agent: "general", prompt: "go", directory: "/wt" })
    await runner.createChildSession({ title: "b", agent: "general" })
    await runner.runChildSession({ sessionID: "s-1", agent: "general", prompt: "go" })
    expect(calls.map((call) => call.query?.directory)).toEqual(["/wt", "/wt", "/base", "/base"])
  })
})

describe("agent() worktree isolation", () => {
  it("falls back without isolation when no working directory is configured", async () => {
    const runner = recordingRunner()
    const result = await runWorkflowScript({
      script: withMeta("return await agent('do it', { isolation: 'worktree' })"),
      runner,
      defaultAgent: "general",
    })
    expect(result.value).toBe("done")
    expect(runner.created[0]?.directory).toBeUndefined()
    expect(runner.runs[0]?.directory).toBeUndefined()
    expect(result.logs.some((log) => log.includes("no working directory"))).toBe(true)
  })

  it("falls back without isolation when the working directory is not a git repository", async () => {
    const plain = await mkdtemp(join(tmpdir(), "open-workflows-plain-"))
    try {
      const runner = recordingRunner()
      const result = await runWorkflowScript({
        script: withMeta("return await agent('do it', { isolation: 'worktree' })"),
        runner,
        defaultAgent: "general",
        workingDirectory: plain,
      })
      expect(result.value).toBe("done")
      expect(runner.created[0]?.directory).toBeUndefined()
      expect(runner.runs[0]?.directory).toBeUndefined()
      expect(result.logs.some((log) => log.includes("not a git repository"))).toBe(true)
    } finally {
      await rm(plain, { recursive: true, force: true })
    }
  })

  it.runIf(gitAvailable)(
    "runs the agent in a fresh worktree and removes it when unchanged",
    async () => {
      const repo = await makeRepo()
      let worktree: string | undefined
      let sawCommittedFile = false
      try {
        const runner = recordingRunner((input) => {
          worktree = input.directory
          if (input.directory) {
            sawCommittedFile = existsSync(join(input.directory, "file.txt"))
          }
        })
        const result = await runWorkflowScript({
          script: withMeta("return await agent('do it', { isolation: 'worktree' })"),
          runner,
          defaultAgent: "general",
          workingDirectory: repo,
        })
        expect(result.value).toBe("done")
        expect(worktree).toBeDefined()
        expect(worktree).not.toBe(repo)
        expect(runner.created[0]?.directory).toBe(worktree)
        expect(sawCommittedFile).toBe(true)
        expect(existsSync(worktree as string)).toBe(false)
        const { stdout } = await execFileAsync("git", ["-C", repo, "worktree", "list", "--porcelain"])
        const entries = stdout.split("\n").filter((line) => line.startsWith("worktree "))
        expect(entries).toHaveLength(1)
      } finally {
        await destroyWorktree(repo, worktree)
        await rm(repo, { recursive: true, force: true })
      }
    },
  )

  it.runIf(gitAvailable)(
    "keeps a dirty worktree, logs its path, and appends it to the text result",
    async () => {
      const repo = await makeRepo()
      let worktree: string | undefined
      try {
        const runner = recordingRunner(async (input) => {
          worktree = input.directory
          await writeFile(join(input.directory as string, "new.txt"), "edited by agent\n")
        })
        const result = await runWorkflowScript({
          script: withMeta("return await agent('do it', { isolation: 'worktree' })"),
          runner,
          defaultAgent: "general",
          workingDirectory: repo,
        })
        expect(worktree).toBeDefined()
        expect(existsSync(worktree as string)).toBe(true)
        expect(existsSync(join(worktree as string, "new.txt"))).toBe(true)
        expect(result.value).toContain("done")
        expect(result.value).toContain(worktree as string)
        expect(result.logs.some((log) => log.includes(`left changes in worktree ${worktree}`))).toBe(true)
      } finally {
        await destroyWorktree(repo, worktree)
        await rm(repo, { recursive: true, force: true })
      }
    },
  )

  it.runIf(gitAvailable)(
    "gives parallel isolated agents distinct worktrees",
    async () => {
      const repo = await makeRepo()
      const worktrees: string[] = []
      try {
        const runner = recordingRunner((input) => {
          if (input.directory) worktrees.push(input.directory)
        })
        await runWorkflowScript({
          script: withMeta(
            [
              "return await parallel([",
              "  () => agent('one', { isolation: 'worktree' }),",
              "  () => agent('two', { isolation: 'worktree' }),",
              "])",
            ].join("\n"),
          ),
          runner,
          defaultAgent: "general",
          workingDirectory: repo,
        })
        expect(worktrees).toHaveLength(2)
        expect(new Set(worktrees).size).toBe(2)
        expect(worktrees).not.toContain(repo)
      } finally {
        for (const worktree of worktrees) await destroyWorktree(repo, worktree)
        await rm(repo, { recursive: true, force: true })
      }
    },
  )
})

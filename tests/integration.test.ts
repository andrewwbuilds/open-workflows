import { describe, expect, it } from "vitest"
import { createDynamicWorkflowTool } from "../src/tool.js"
import type { OpencodeClientLike } from "../src/runtime/sdk.js"

interface FakeRequest {
  url: string
  method: string
  body?: unknown
}

class FakeOpencodeClient {
  requests: FakeRequest[] = []
  sessions: Map<string, { id: string; parentID?: string; title: string }> = new Map()
  private counter = 0

  session = {
    create: async (opts: { body?: { parentID?: string; title?: string }; query?: { directory?: string } }) => {
      this.requests.push({ url: "/session", method: "POST", body: opts })
      this.counter += 1
      const id = `s-${this.counter}`
      this.sessions.set(id, { id, parentID: opts.body?.parentID, title: opts.body?.title ?? "" })
      return { data: { id, projectID: "p", directory: opts.query?.directory ?? "/tmp", title: opts.body?.title ?? "", time: { created: 0, updated: 0 }, version: "1" } }
    },
    prompt: async (opts: { path: { id: string }; body: { parts: Array<{ type: string; text?: string }> } }) => {
      this.requests.push({ url: `/session/${opts.path.id}/message`, method: "POST", body: opts.body })
      const textPart = opts.body.parts.find((p) => p.type === "text") as { text?: string } | undefined
      const text = textPart?.text ?? ""
      const reply = this.replyFor(text)
      return {
        data: {
          info: { id: `m-${this.counter}`, sessionID: opts.path.id, role: "assistant", time: { created: 0 }, parentID: "x", modelID: "x", providerID: "x", mode: "x", path: { cwd: "/tmp", root: "/tmp" }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } },
          parts: [{ id: `p-${this.counter}`, sessionID: opts.path.id, messageID: `m-${this.counter}`, type: "text", text: reply }],
        },
      }
    },
    delete: async () => ({ data: true }),
    update: async () => ({ data: true }),
  }

  private plannerCallCount = 0
  private reviewerCallCount = 0
  private workerCallCount = 0

  private replyFor(prompt: string): string {
    if (prompt.includes("planner in a coordinated")) {
      this.plannerCallCount += 1
      return JSON.stringify({
        plan: [
          { id: "t1", title: "Inspect auth", description: "Read the auth flow.", kind: "research" },
        ],
        rationale: "first pass",
      })
    }
    if (prompt.includes("reviewer in a coordinated")) {
      this.reviewerCallCount += 1
      return JSON.stringify({
        status: "pass",
        summary: "looks good",
        followUps: [],
        criteriaMet: [],
        criteriaMissed: [],
      })
    }
    if (prompt.includes("worker in the workflow")) {
      this.workerCallCount += 1
      return JSON.stringify({ status: "completed", summary: "done" })
    }
    return ""
  }
}

describe("createDynamicWorkflowTool (integration)", () => {
  it("creates child sessions through the OpenCode client and returns a summary", async () => {
    const fake = new FakeOpencodeClient()
    const workflowTool = createDynamicWorkflowTool({
      client: fake as unknown as OpencodeClientLike,
      pluginOptions: { maxRounds: 1, maxWorkers: 1 },
    })
    const ctx = {
      sessionID: "parent",
      messageID: "msg",
      agent: "build",
      directory: "/tmp",
      worktree: "/tmp",
      abort: new AbortController().signal,
      metadata: () => undefined,
      ask: () => undefined,
    }
    const args = (workflowTool as { args: Record<string, unknown>; execute: (a: unknown, c: unknown) => Promise<unknown> }).args
    void args
    const execute = (workflowTool as { execute: (a: unknown, c: unknown) => Promise<unknown> }).execute
    const result = (await execute({ goal: "Inspect auth." }, ctx)) as string
    expect(result).toContain("Workflow status: completed")
    expect(result).toContain("planner:")
    expect(result).toContain("worker:")
    expect(result).toContain("reviewer:")
    expect(fake.requests.some((r) => r.url === "/session" && r.method === "POST")).toBe(true)
    expect(fake.requests.some((r) => r.url.endsWith("/message"))).toBe(true)
  })
})
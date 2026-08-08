import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { runWorkflowScript } from "../src/script/engine.js"
import { createFakeRunner } from "../src/runtime/fake.js"
import { childSessionTitle, createSdkRunner, type OpencodeClientLike } from "../src/runtime/sdk.js"
import { WorkflowProgress, type ProgressUpdate } from "../src/progress.js"
import { createWorkflowScriptTool } from "../src/tool.js"

function withMeta(body: string): string {
  return `export const meta = { name: 'vis', description: 'visibility' }\n${body}`
}

const tempDirs: string[] = []

async function tempWorkingDirectory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "open-workflows-vis-"))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("child sessions are identifiable", () => {
  it("titles a child session with its phase and label", () => {
    expect(childSessionTitle({ title: "scan repo", phase: "Scan" })).toBe("Scan · scan repo")
    expect(childSessionTitle({ title: "scan repo" })).toBe("scan repo")
    expect(childSessionTitle({ title: "scan repo", phase: "  " })).toBe("scan repo")
  })

  it("sends the composed title to session.create", async () => {
    const bodies: Array<Record<string, unknown>> = []
    const client = {
      session: {
        create: async (opts: { body: Record<string, unknown> }) => {
          bodies.push(opts.body)
          return { data: { id: "child-1" } }
        },
        prompt: async () => ({ data: { info: {}, parts: [] } }),
        delete: async () => ({ data: true }),
      },
    } as unknown as OpencodeClientLike
    const runner = createSdkRunner(client, "parent")
    await runner.createChildSession({ title: "find flaky tests", agent: "general", phase: "Scan" })
    expect(bodies[0]?.title).toBe("Scan · find flaky tests")
    expect(bodies[0]?.parentID).toBe("parent")
  })

  it("passes the phase through to the runner", async () => {
    const runner = createFakeRunner({ defaultResponse: "ok" })
    await runWorkflowScript({
      script: withMeta("phase('Scan')\nawait agent('look around', { label: 'scout' })"),
      runner,
      defaultAgent: "general",
    })
    expect(runner.created[0]?.phase).toBe("Scan")
    expect(runner.created[0]?.title).toBe("scout")
  })

  it("reports each child session with its label and phase in the result", async () => {
    const runner = createFakeRunner({ defaultResponse: "ok" })
    const result = await runWorkflowScript({
      script: withMeta(
        [
          "phase('Scan')",
          "await agent('a', { label: 'one' })",
          "await agent('b', { label: 'two', phase: 'Verify' })",
        ].join("\n"),
      ),
      runner,
      defaultAgent: "general",
    })
    expect(result.children).toEqual([
      { sessionID: "fake-1", label: "one", phase: "Scan" },
      { sessionID: "fake-2", label: "two", phase: "Verify" },
    ])
    expect(result.sessionIDs).toEqual(["fake-1", "fake-2"])
  })

  it("streams child sessions into the progress metadata", async () => {
    const updates: ProgressUpdate[] = []
    const progress = new WorkflowProgress({ name: "t", throttleMs: 0, sink: (u) => updates.push(u) })
    const runner = createFakeRunner({ defaultResponse: "ok" })
    await runWorkflowScript({
      script: withMeta("phase('Scan')\nawait agent('a', { label: 'one' })"),
      runner,
      defaultAgent: "general",
      events: {
        onPhase: (title) => progress.phase(title),
        onChildSession: (child) => progress.childSession(child),
      },
    })
    const children = updates[updates.length - 1]?.metadata?.children as unknown[]
    expect(children).toEqual([{ sessionID: "fake-1", label: "one", phase: "Scan" }])
  })

  it("de-duplicates repeated child session reports", () => {
    const updates: ProgressUpdate[] = []
    const progress = new WorkflowProgress({ name: "t", throttleMs: 0, sink: (u) => updates.push(u) })
    progress.childSession({ sessionID: "a", label: "one" })
    progress.childSession({ sessionID: "a", label: "one" })
    expect(updates[updates.length - 1]?.metadata?.children).toHaveLength(1)
  })
})

describe("the workflow tool reports where each subagent ran", () => {
  function fakeClient(): OpencodeClientLike {
    let counter = 0
    return {
      session: {
        create: async () => {
          counter += 1
          return { data: { id: `ses_child_${counter}` } }
        },
        prompt: async (opts: { path: { id: string } }) => ({
          data: {
            info: {},
            parts: [{ type: "text", text: "done", id: "p", sessionID: opts.path.id, messageID: "m" }],
          },
        }),
        delete: async () => ({ data: true }),
      },
    } as unknown as OpencodeClientLike
  }

  function toolContext(directory: string | undefined) {
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

  function execute(tool: unknown) {
    return (tool as { execute: (a: unknown, c: unknown) => Promise<string> }).execute
  }

  it("lists every child session id with its label", async () => {
    const directory = await tempWorkingDirectory()
    const tool = createWorkflowScriptTool({ client: fakeClient(), pluginOptions: {} })
    const output = await execute(tool)(
      {
        script: withMeta("phase('Scan')\nawait agent('look', { label: 'scout' })"),
      },
      toolContext(directory),
    )
    expect(output).toContain("Child sessions:")
    expect(output).toContain("Scan · scout: ses_child_1")
  })

  it("runs a workflow from a scriptPath", async () => {
    const directory = await tempWorkingDirectory()
    const scriptPath = join(directory, "saved.js")
    await writeFile(
      scriptPath,
      "export const meta = { name: 'saved', description: 'd' }\nreturn 'from file: ' + args.n",
      "utf8",
    )
    const tool = createWorkflowScriptTool({ client: fakeClient(), pluginOptions: {} })
    const output = await execute(tool)({ scriptPath, args: { n: 7 } }, toolContext(directory))
    expect(output).toContain("from file: 7")
    expect(output).toContain("Workflow: saved")
  })

  it("resolves a bare saved-workflow name from scriptPath", async () => {
    const directory = await tempWorkingDirectory()
    const workflowsDir = join(directory, ".opencode", "workflows")
    await mkdir(workflowsDir, { recursive: true })
    await writeFile(
      join(workflowsDir, "tidy.js"),
      "export const meta = { name: 'tidy', description: 'd' }\nreturn 'tidied'",
      "utf8",
    )
    const tool = createWorkflowScriptTool({ client: fakeClient(), pluginOptions: {} })
    const output = await execute(tool)({ scriptPath: "tidy" }, toolContext(directory))
    expect(output).toContain("tidied")
  })

  it("requires exactly one of script and scriptPath", async () => {
    const directory = await tempWorkingDirectory()
    const tool = createWorkflowScriptTool({ client: fakeClient(), pluginOptions: {} })
    expect(await execute(tool)({}, toolContext(directory))).toContain(
      "one of script or scriptPath is required",
    )
    expect(
      await execute(tool)(
        { script: withMeta("return 1"), scriptPath: "tidy" },
        toolContext(directory),
      ),
    ).toContain("not both")
  })

  it("reports an unreadable scriptPath instead of running nothing", async () => {
    const directory = await tempWorkingDirectory()
    const tool = createWorkflowScriptTool({ client: fakeClient(), pluginOptions: {} })
    const output = await execute(tool)(
      { scriptPath: join(directory, "missing.js") },
      toolContext(directory),
    )
    expect(output).toContain("could not read the script at")
  })

  it("says a run is not resumable when there is no working directory", async () => {
    const tool = createWorkflowScriptTool({ client: fakeClient(), pluginOptions: {} })
    const output = await execute(tool)(
      { script: withMeta("return 1") },
      toolContext(undefined),
    )
    expect(output).toContain("not resumable")
    expect(output).not.toContain("pass resumeFromRunId to resume")
  })
})

/**
 * Fixtures for the TUI viewer.
 *
 * The two message sources hand back DIFFERENT shapes, and the code has to read
 * each correctly: `api.state.session.messages` yields FLAT Message objects,
 * `api.client.session.messages` yields `{ info, parts }` wrappers. Both are
 * modelled below exactly as opencode 1.15.10 produces them, including the
 * `step-finish` part every real assistant message ends with.
 */
type FakeMessageInfo = Record<string, unknown>

function assistantInfo(sessionID: string, over: Record<string, unknown> = {}): FakeMessageInfo {
  return {
    id: `msg_${sessionID}`,
    sessionID,
    role: "assistant",
    parentID: "p",
    mode: "build",
    agent: "general",
    modelID: "canned-model",
    providerID: "canned",
    path: { cwd: "/tmp", root: "/tmp" },
    cost: 0,
    tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, completed: 2 },
    finish: "stop",
    ...over,
  }
}

const apiError = {
  name: "APIError",
  data: { message: "scripted upstream failure for e2e", statusCode: 400, isRetryable: false },
}

function userInfo(sessionID: string): FakeMessageInfo {
  return { id: `msg_${sessionID}_u`, sessionID, role: "user", time: { created: 1 } }
}

/** The `{ info, parts }` wrapper GET /session/{id}/message returns. */
function wrapped(info: FakeMessageInfo): { info: FakeMessageInfo; parts: Array<Record<string, unknown>> } {
  const messageID = info.id as string
  const sessionID = info.sessionID as string
  if (info.role === "user") {
    return { info, parts: [{ id: "p0", sessionID, messageID, type: "text", text: "go" }] }
  }
  return {
    info,
    parts: [
      { id: "p1", sessionID, messageID, type: "step-start" },
      { id: "p2", sessionID, messageID, type: "text", text: "done" },
      { id: "p3", sessionID, messageID, type: "step-finish" },
    ],
  }
}

interface FakeHostOptions {
  children?: Array<{ id: string; title: string; time: { created: number; updated: number } }>
  status?: (id: string) => { type: string } | undefined
  /** Per-session flat messages in the TUI store; undefined models a host without the API. */
  stateMessages?: Map<string, FakeMessageInfo[]> | undefined
  omitStateMessages?: boolean
  /** Per-session stored transcripts served over HTTP. */
  storedMessages?: Map<string, FakeMessageInfo[]>
  route?: { name: string; params?: Record<string, unknown> }
}

function fakeHost(options: FakeHostOptions = {}) {
  const navigated: Array<{ name: string; params?: Record<string, unknown> }> = []
  const disposers: Array<() => void> = []
  const handlers = new Map<string, Array<(event: unknown) => void>>()
  const messageCalls: Array<Record<string, unknown>> = []
  let childrenCalls = 0
  let replaces = 0
  let registered: Array<{ name: string; title: string; desc?: string; namespace?: string; run: () => void }> = []
  let rendered: (() => unknown) | undefined
  let selectProps:
    | {
        title: string
        options: Array<{ title: string; value: string; description?: string }>
        onSelect?: (o: { value: string }) => void
      }
    | undefined

  const api = {
    route: {
      current: options.route ?? { name: "session", params: { sessionID: "parent" } },
      navigate: (name: string, params?: Record<string, unknown>) => navigated.push({ name, params }),
    },
    client: {
      session: {
        children: async () => {
          childrenCalls += 1
          return { data: options.children ?? [] }
        },
        messages: async (parameters: Record<string, unknown>) => {
          messageCalls.push(parameters)
          const stored = options.storedMessages?.get(parameters.sessionID as string) ?? []
          const limit = parameters.limit as number | undefined
          const slice = limit === undefined ? stored : stored.slice(-limit)
          return { data: slice.map(wrapped) }
        },
      },
    },
    state: {
      session: {
        status: options.status ?? (() => undefined),
        ...(options.omitStateMessages
          ? {}
          : { messages: (id: string) => options.stateMessages?.get(id) ?? [] }),
      },
    },
    ui: {
      dialog: {
        replace: (render: () => unknown) => {
          replaces += 1
          rendered = render
        },
        clear: () => {},
        open: true,
        depth: 1,
      },
      DialogSelect: (props: never) => {
        selectProps = props
        return null
      },
      toast: () => {},
    },
    keymap: {
      registerLayer: (layer: {
        commands: Array<{ name: string; title: string; desc?: string; namespace?: string; run: () => void }>
      }) => {
        registered = layer.commands
        return () => {}
      },
    },
    event: {
      on: (type: string, handler: (event: unknown) => void) => {
        const list = handlers.get(type) ?? []
        list.push(handler)
        handlers.set(type, list)
        return () => {}
      },
    },
    lifecycle: { onDispose: (fn: () => void) => disposers.push(fn) },
  }

  return {
    api,
    navigated,
    disposers,
    messageCalls,
    handlers,
    get childrenCalls() {
      return childrenCalls
    },
    get replaces() {
      return replaces
    },
    get registered() {
      return registered
    },
    get selectProps() {
      return selectProps
    },
    async open() {
      registered[0]?.run()
      await new Promise((resolve) => setTimeout(resolve, 0))
      rendered?.()
    },
    emit(type: string, event: unknown) {
      for (const handler of handlers.get(type) ?? []) handler(event)
    },
    /** Run the render thunk the dialog last stored, as the host would. */
    paint() {
      rendered?.()
    },
  }
}

const CHILDREN = [
  { id: "c1", title: "Scan · one", time: { created: 1, updated: 5 } },
  { id: "c2", title: "Scan · two", time: { created: 2, updated: 9 } },
]

describe("the TUI subagent viewer module", () => {
  it("default-exports a TuiPluginModule with the plugin id and no server key", async () => {
    const mod = await import("../src/tui.js")
    expect(mod.default.id).toBe("open-workflows")
    expect(mod.default.tui).toBeTypeOf("function")
    // TuiPluginModule.server is `never`; a server key here would break loading.
    expect(Object.hasOwn(mod.default, "server")).toBe(false)
  })

  it("registers a command, lists children with live status, and navigates on select", async () => {
    const mod = await import("../src/tui.js")
    // BEHAVIOR CHANGE: a settled child used to render "idle", which said
    // nothing about whether it succeeded. It now reports what its last stored
    // message says - here "done".
    const host = fakeHost({
      children: CHILDREN,
      status: (id) => (id === "c2" ? { type: "busy" } : { type: "idle" }),
      stateMessages: new Map([["c1", [assistantInfo("c1")]]]),
    })
    await mod.OpenWorkflowsTui(host.api as never, undefined, {} as never)
    expect(host.registered.map((command) => command.name)).toEqual(["workflow.subagents"])
    expect(host.registered[0]?.namespace).toBe("palette")
    expect(host.registered[0]?.desc).toBeTruthy()
    await host.open()

    expect(host.selectProps?.title).toBe("Workflow subagents")
    // Most recently updated first, with the live session marked running.
    expect(host.selectProps?.options.map((option) => option.title)).toEqual(["Scan · two", "Scan · one"])
    expect(host.selectProps?.options[0]?.description).toBe("running · c2")
    expect(host.selectProps?.options[1]?.description).toBe("done · c1")

    host.selectProps?.onSelect?.({ value: "c2" })
    expect(host.navigated).toEqual([{ name: "session", params: { sessionID: "c2" } }])
    expect(host.disposers).toHaveLength(1)
  })

  it("reports a failed subagent as failed, with the error class", async () => {
    const mod = await import("../src/tui.js")
    const host = fakeHost({
      children: [{ id: "doomed", title: "Scan · doomed", time: { created: 1, updated: 5 } }],
      status: () => ({ type: "idle" }),
      stateMessages: new Map([["doomed", [userInfo("doomed"), assistantInfo("doomed", { error: apiError, finish: undefined })]]]),
    })
    await mod.OpenWorkflowsTui(host.api as never, undefined, {} as never)
    await host.open()
    expect(host.selectProps?.options[0]?.description).toBe("failed · APIError · doomed")
    // The in-memory store already carries the error, so nothing is fetched.
    expect(host.messageCalls).toEqual([])
  })

  it("tells a cancelled subagent apart from a failed one", async () => {
    const mod = await import("../src/tui.js")
    const host = fakeHost({
      children: [{ id: "stopped", title: "Scan · stopped", time: { created: 1, updated: 5 } }],
      status: () => ({ type: "idle" }),
      stateMessages: new Map([
        ["stopped", [assistantInfo("stopped", { error: { name: "MessageAbortedError", data: { message: "Aborted" } } })]],
      ]),
    })
    await mod.OpenWorkflowsTui(host.api as never, undefined, {} as never)
    await host.open()
    expect(host.selectProps?.options[0]?.description).toBe("cancelled · MessageAbortedError · stopped")
  })

  it("reports a turn still in flight as running, even when the status says idle", async () => {
    const mod = await import("../src/tui.js")
    const host = fakeHost({
      children: [
        { id: "open", title: "a", time: { created: 1, updated: 5 } },
        { id: "prompted", title: "b", time: { created: 1, updated: 4 } },
      ],
      status: () => ({ type: "idle" }),
      stateMessages: new Map([
        ["open", [assistantInfo("open", { time: { created: 1 }, finish: undefined })]],
        // Only the user prompt is stored yet: the assistant turn has not begun.
        ["prompted", [userInfo("prompted")]],
      ]),
    })
    await mod.OpenWorkflowsTui(host.api as never, undefined, {} as never)
    await host.open()
    expect(host.selectProps?.options.map((option) => option.description)).toEqual([
      "running · open",
      "running · prompted",
    ])
  })

  it("lets a live busy status win over an errored message so a retry does not read as failed", async () => {
    const mod = await import("../src/tui.js")
    const host = fakeHost({
      children: [{ id: "retrying", title: "a", time: { created: 1, updated: 5 } }],
      status: () => ({ type: "busy" }),
      stateMessages: new Map([["retrying", [assistantInfo("retrying", { error: apiError })]]]),
    })
    await mod.OpenWorkflowsTui(host.api as never, undefined, {} as never)
    await host.open()
    expect(host.selectProps?.options[0]?.description).toBe("running · retrying")
    expect(host.messageCalls).toEqual([])
  })

  it("maps a retry status to retrying", async () => {
    const mod = await import("../src/tui.js")
    const host = fakeHost({
      children: [{ id: "r", title: "a", time: { created: 1, updated: 5 } }],
      status: () => ({ type: "retry" }),
    })
    await mod.OpenWorkflowsTui(host.api as never, undefined, {} as never)
    await host.open()
    expect(host.selectProps?.options[0]?.description).toBe("retrying · r")
  })

  it("resolves subagents of a workflow that ran before this TUI started", async () => {
    const mod = await import("../src/tui.js")
    // The cold case: no live status and an empty in-memory store, which used to
    // render every finished subagent as "queued".
    const host = fakeHost({
      children: CHILDREN,
      status: () => undefined,
      stateMessages: new Map(),
      storedMessages: new Map([
        ["c1", [userInfo("c1"), assistantInfo("c1")]],
        ["c2", [userInfo("c2"), assistantInfo("c2", { error: apiError, finish: undefined })]],
      ]),
    })
    await mod.OpenWorkflowsTui(host.api as never, undefined, {} as never)
    await host.open()
    expect(host.selectProps?.options.map((option) => option.description)).toEqual([
      "failed · APIError · c2",
      "done · c1",
    ])
    // Exactly one newest-message read per child, with flat v2 parameters.
    expect(host.messageCalls).toEqual([
      { sessionID: "c2", limit: 1 },
      { sessionID: "c1", limit: 1 },
    ])
  })

  it("reads the client source as {info, parts} and the state source as a flat message", async () => {
    const mod = await import("../src/tui.js")
    // Confusing the two shapes is the single easiest thing to get wrong here:
    // it degrades every row to "unknown" without failing anything else.
    const host = fakeHost({
      children: CHILDREN,
      status: () => undefined,
      stateMessages: new Map([["c1", [assistantInfo("c1", { error: apiError })]]]),
      storedMessages: new Map([["c2", [assistantInfo("c2")]]]),
    })
    await mod.OpenWorkflowsTui(host.api as never, undefined, {} as never)
    await host.open()
    expect(host.selectProps?.options.map((option) => option.description)).toEqual([
      "done · c2",
      "failed · APIError · c1",
    ])
    expect(host.messageCalls).toEqual([{ sessionID: "c2", limit: 1 }])
  })

  it("works on a host that does not expose state.session.messages", async () => {
    const mod = await import("../src/tui.js")
    const host = fakeHost({
      children: [{ id: "c1", title: "a", time: { created: 1, updated: 5 } }],
      status: () => undefined,
      omitStateMessages: true,
      storedMessages: new Map([["c1", [assistantInfo("c1")]]]),
    })
    await mod.OpenWorkflowsTui(host.api as never, undefined, {} as never)
    await host.open()
    expect(host.selectProps?.options[0]?.description).toBe("done · c1")
    expect(host.messageCalls).toEqual([{ sessionID: "c1", limit: 1 }])
  })

  it("reports unknown rather than done when a child's transcript cannot be read", async () => {
    const mod = await import("../src/tui.js")
    const host = fakeHost({
      children: [{ id: "c1", title: "a", time: { created: 1, updated: 5 } }],
      status: () => undefined,
      stateMessages: new Map(),
      storedMessages: new Map(),
    })
    await mod.OpenWorkflowsTui(host.api as never, undefined, {} as never)
    await host.open()
    expect(host.selectProps?.options[0]?.description).toBe("unknown · c1")
  })

  it("memoizes a settled outcome on the child's time.updated", async () => {
    const mod = await import("../src/tui.js")
    const children = [{ id: "c1", title: "a", time: { created: 1, updated: 5 } }]
    const host = fakeHost({
      children,
      status: () => undefined,
      stateMessages: new Map(),
      storedMessages: new Map([["c1", [assistantInfo("c1")]]]),
    })
    await mod.OpenWorkflowsTui(host.api as never, undefined, {} as never)
    await host.open()
    await host.open()
    expect(host.messageCalls).toHaveLength(1)
    // A moved transcript invalidates the entry.
    children[0]!.time.updated = 6
    await host.open()
    expect(host.messageCalls).toHaveLength(2)
  })

  it("does not memoize an unreadable transcript", async () => {
    const mod = await import("../src/tui.js")
    const stored = new Map<string, FakeMessageInfo[]>()
    const host = fakeHost({
      children: [{ id: "c1", title: "a", time: { created: 1, updated: 5 } }],
      status: () => undefined,
      stateMessages: new Map(),
      storedMessages: stored,
    })
    await mod.OpenWorkflowsTui(host.api as never, undefined, {} as never)
    await host.open()
    expect(host.selectProps?.options[0]?.description).toBe("unknown · c1")
    // The read recovers without the child having changed, so "unknown" must not
    // have been cached as if it were a settled outcome.
    stored.set("c1", [assistantInfo("c1")])
    await host.open()
    expect(host.selectProps?.options[0]?.description).toBe("done · c1")
  })

  it("caps cold lookups and leaves the rest to a later refresh", async () => {
    const mod = await import("../src/tui.js")
    const children = Array.from({ length: 100 }, (_, index) => ({
      id: `c${index}`,
      title: `a${index}`,
      time: { created: 1, updated: 100 - index },
    }))
    const stored = new Map(children.map((child) => [child.id, [assistantInfo(child.id)]]))
    const host = fakeHost({
      children,
      status: () => undefined,
      stateMessages: new Map(),
      storedMessages: stored,
    })
    await mod.OpenWorkflowsTui(host.api as never, undefined, {} as never)
    await host.open()
    expect(host.messageCalls.length).toBeLessThanOrEqual(64)
    const descriptions = host.selectProps?.options.map((option) => option.description) ?? []
    expect(descriptions[0]).toBe("done · c0")
    expect(descriptions[99]).toBe("unknown · c99")
    // A second pass spends a fresh budget on the rows still unresolved.
    await host.open()
    expect(host.messageCalls.length).toBeGreaterThan(64)
  })

  it("subscribes to message.updated and session.error, and drops the cached outcome", async () => {
    const mod = await import("../src/tui.js")
    const stored = new Map([["c1", [assistantInfo("c1")]]])
    const host = fakeHost({
      children: [{ id: "c1", title: "a", time: { created: 1, updated: 5 } }],
      status: () => undefined,
      stateMessages: new Map(),
      storedMessages: stored,
    })
    await mod.OpenWorkflowsTui(host.api as never, undefined, {} as never)
    expect([...host.handlers.keys()].sort()).toEqual([
      "message.updated",
      "session.error",
      "session.idle",
      "session.status",
      "session.updated",
    ])
    await host.open()
    expect(host.messageCalls).toHaveLength(1)

    // The error lands on the message AFTER session.idle, so the message.updated
    // that carries it must invalidate the memoized "done".
    stored.set("c1", [assistantInfo("c1", { error: apiError, finish: undefined })])
    host.emit("message.updated", { properties: { sessionID: "c1", info: { id: "msg_c1" } } })
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(host.messageCalls).toHaveLength(2)
    host.paint()
    expect(host.selectProps?.options[0]?.description).toBe("failed · APIError · c1")
  })

  it("coalesces a burst of events into a single refresh", async () => {
    const mod = await import("../src/tui.js")
    const host = fakeHost({
      children: [{ id: "c1", title: "a", time: { created: 1, updated: 5 } }],
      status: () => ({ type: "busy" }),
    })
    await mod.OpenWorkflowsTui(host.api as never, undefined, {} as never)
    await host.open()
    const before = host.childrenCalls
    for (let index = 0; index < 20; index += 1) {
      host.emit("message.updated", { properties: { sessionID: "c1", info: { id: "msg_c1" } } })
      host.emit("session.status", { properties: { sessionID: "c1" } })
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(host.childrenCalls - before).toBe(1)
  })

  it("toasts instead of opening an empty dialog when no session is in view", async () => {
    const mod = await import("../src/tui.js")
    const toasts: Array<{ message: string }> = []
    let replaced = false
    let commands: Array<{ onSelect: () => void }> = []
    const api = {
      route: { current: { name: "home" }, navigate: () => {} },
      client: { session: { children: async () => ({ data: [] }) } },
      state: { session: { status: () => undefined } },
      ui: {
        dialog: { replace: () => { replaced = true }, clear: () => {}, open: false },
        DialogSelect: () => null,
        toast: (input: { message: string }) => toasts.push(input),
      },
      keymap: {
        registerLayer: (layer: { commands: Array<{ onSelect: () => void }> }) => {
          commands = layer.commands
          return () => {}
        },
      },
      event: { on: () => () => {} },
      lifecycle: { onDispose: () => {} },
    }
    await mod.OpenWorkflowsTui(api as never, undefined, {} as never)
    commands[0]?.run()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(toasts.map((toast) => toast.message)).toEqual([
      "Open a session first - subagents are listed per session.",
    ])
    expect(replaced).toBe(false)
  })

  it("falls back to the deprecated command API when the host has no keymap layer", async () => {
    const mod = await import("../src/tui.js")
    let legacy: Array<{ value: string; title: string }> = []
    const api = {
      route: { current: { name: "home" }, navigate: () => {} },
      client: { session: { children: async () => ({ data: [] }) } },
      state: { session: { status: () => undefined } },
      ui: {
        dialog: { replace: () => {}, clear: () => {}, open: false },
        DialogSelect: () => null,
        toast: () => {},
      },
      command: {
        register: (build: () => Array<{ value: string; title: string }>) => {
          legacy = build()
          return () => {}
        },
      },
      event: { on: () => () => {} },
      lifecycle: { onDispose: () => {} },
    }
    await mod.OpenWorkflowsTui(api as never, undefined, {} as never)
    expect(legacy).toEqual([
      {
        value: "workflow.subagents",
        title: "View workflow subagents",
        description: "List the child sessions this workflow spawned and jump into one",
        onSelect: expect.any(Function),
      },
    ])
  })
})

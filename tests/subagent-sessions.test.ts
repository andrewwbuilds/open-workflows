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
    const disposers: Array<() => void> = []
    const navigated: Array<{ name: string; params?: Record<string, unknown> }> = []
    let selectProps: { title: string; options: Array<{ title: string; value: string; description?: string }>; onSelect?: (o: { value: string }) => void } | undefined
    // The host command contract is {name, title, desc, namespace, run} - NOT
    // {description, onSelect}. This fake mirrored the wrong shape, which is why
    // a registerLayer registration the palette could never list looked fine.
    let registered: Array<{ name: string; title: string; desc?: string; namespace?: string; run: () => void }> = []
    let rendered: (() => unknown) | undefined

    const api = {
      route: {
        current: { name: "session", params: { sessionID: "parent" } },
        navigate: (name: string, params?: Record<string, unknown>) => navigated.push({ name, params }),
      },
      client: {
        session: {
          children: async () => ({
            data: [
              { id: "c1", title: "Scan · one", time: { created: 1, updated: 5 } },
              { id: "c2", title: "Scan · two", time: { created: 2, updated: 9 } },
            ],
          }),
        },
      },
      state: {
        session: {
          status: (id: string) => (id === "c2" ? { type: "busy" } : { type: "idle" }),
        },
      },
      ui: {
        dialog: { replace: (render: () => unknown) => { rendered = render }, clear: () => {}, open: true },
        DialogSelect: (props: never) => {
          selectProps = props
          return null
        },
        toast: () => {},
      },
      keymap: {
        registerLayer: (layer: { commands: Array<{ name: string; title: string; desc?: string; namespace?: string; run: () => void }> }) => {
          registered = layer.commands
          return () => {}
        },
      },
      event: { on: () => () => {} },
      lifecycle: { onDispose: (fn: () => void) => disposers.push(fn) },
    }

    await mod.OpenWorkflowsTui(api as never, undefined, {} as never)
    expect(registered.map((command) => command.name)).toEqual(["workflow.subagents"])

    expect(registered[0]?.namespace).toBe("palette")
    expect(registered[0]?.desc).toBeTruthy()
    registered[0]?.run()
    await new Promise((resolve) => setTimeout(resolve, 0))
    rendered?.()

    expect(selectProps?.title).toBe("Workflow subagents")
    // Most recently updated first, with the live session marked running.
    expect(selectProps?.options.map((option) => option.title)).toEqual(["Scan · two", "Scan · one"])
    expect(selectProps?.options[0]?.description).toBe("running · c2")
    expect(selectProps?.options[1]?.description).toBe("idle · c1")

    selectProps?.onSelect?.({ value: "c2" })
    expect(navigated).toEqual([{ name: "session", params: { sessionID: "c2" } }])
    expect(disposers).toHaveLength(1)
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

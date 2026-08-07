import type {
  TuiDialogSelectOption,
  TuiPlugin,
  TuiPluginApi,
  TuiPluginModule,
} from "@opencode-ai/plugin/tui"
import { PLUGIN_ID } from "./plugin-id.js"

/**
 * A subagent viewer for workflows, registered as a TUI plugin.
 *
 * WHY THIS EXISTS INSTEAD OF THE NATIVE PANEL. OpenCode's own "View subagents"
 * panel cannot be reached from a plugin, and the reason is structural rather
 * than a missing API:
 *
 *   - The panel's tab list is built from exactly one input: tool parts named
 *     `task` in the attached session whose tool metadata carries `sessionId`.
 *     Sessions with a `parentID` are never enumerated into it - creating a
 *     child session with `parentID` (which is what agent() does) produces no
 *     message part at all, so there is nothing for the reducer to see.
 *   - The only producer of such a part is OpenCode's built-in task tool, and
 *     the only way to invoke it is a `subtask` part on a USER message. Posting
 *     one queues behind the turn that is currently running - which is the very
 *     turn the workflow tool is executing inside - so a workflow that tried it
 *     would deadlock waiting for itself. `noReply` does not help: it
 *     short-circuits before the prompt loop, so the subtask would be stored and
 *     never executed.
 *   - No HTTP endpoint writes message parts, `/tui/publish` cannot forge
 *     `message.part.updated`, and no server-plugin hook creates parts.
 *     `ToolContext.metadata()` writes onto the plugin's own part, whose tool
 *     name is `workflow` - rejected by the panel's first gate.
 *   - Registering a plugin tool literally named `task` would shadow the
 *     built-in one globally (tool ids are un-namespaced and custom tools are
 *     applied last) and still gain nothing, because agent() is not a model tool
 *     call in the first place. Do not do it.
 *
 * That panel also only exists in `opencode run`'s interactive footer; the
 * default full-screen TUI has no subagent panel at all. So this dialog is not
 * a downgrade there - it is the only such view, and it is built entirely on
 * supported APIs: `session.children` for the list, `state.session.status` for
 * live status, and `route.navigate` to open one.
 *
 * KNOWN LIMITATION: TUI plugins load only in the full TUI. This viewer is not
 * reachable from `opencode run` interactive mode, which has no plugin surface.
 */
const COMMAND = "workflow.subagents"

type ChildRow = {
  id: string
  title: string
  status: string
  updatedAt: number
}

export const OpenWorkflowsTui: TuiPlugin = async (api) => {
  let rows: ChildRow[] = []
  let openSessionID: string | undefined
  let ourDepth = 0

  const currentSessionID = (): string | undefined => {
    const route = api.route.current
    if (route.name !== "session") return undefined
    const sessionID = (route.params as { sessionID?: unknown } | undefined)?.sessionID
    return typeof sessionID === "string" ? sessionID : undefined
  }

  const load = async (sessionID: string): Promise<ChildRow[]> => {
    const response = await api.client.session.children({ sessionID })
    const children = response.data ?? []
    return children
      .map((child) => ({
        id: child.id,
        title: child.title,
        status: describeStatus(api, child.id),
        updatedAt: readUpdatedAt(child),
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  const render = (): void => {
    api.ui.dialog.replace(() =>
      api.ui.DialogSelect<string>({
        title: "Workflow subagents",
        placeholder: rows.length > 0 ? "Filter subagents" : "No workflow subagents in this session",
        options: rows.map(toOption),
        onSelect: (option) => {
          api.ui.dialog.clear()
          api.route.navigate("session", { sessionID: option.value })
        },
      }),
    )
  }

  const open = async (): Promise<void> => {
    const sessionID = currentSessionID()
    if (!sessionID) {
      api.ui.toast({
        variant: "info",
        message: "Open a session first - subagents are listed per session.",
      })
      return
    }
    try {
      rows = await load(sessionID)
    } catch {
      api.ui.toast({ variant: "error", message: "Could not read this session's subagents." })
      return
    }
    openSessionID = sessionID
    render()
    // Remember how deep our dialog sits so refresh can tell "our dialog is
    // still up" from "the user opened the model picker on top of it".
    ourDepth = api.ui.dialog.depth
  }

  // Live refresh: while the dialog is open, re-read the children whenever a
  // session changes state, so an agent that finishes mid-look updates in place.
  /** True only while OUR dialog is the frontmost one. */
  const ours = (): boolean =>
    openSessionID !== undefined && api.ui.dialog.open && api.ui.dialog.depth === ourDepth

  const refresh = (): void => {
    if (!openSessionID) return
    if (!api.ui.dialog.open) {
      openSessionID = undefined
      return
    }
    // Something else is on top (session switcher, model picker). Re-rendering
    // now would call dialog.replace and clobber it.
    if (!ours()) return
    void load(openSessionID)
      .then((next) => {
        if (!ours()) return
        if (sameRows(rows, next)) return
        rows = next
        render()
      })
      .catch(() => {
        // A transient read failure just leaves the last snapshot on screen.
      })
  }

  const unsubscribe = [
    api.event.on("session.updated", refresh),
    api.event.on("session.status", refresh),
    api.event.on("session.idle", refresh),
  ]

  const TITLE = "View workflow subagents"
  const DESC = "List the child sessions this workflow spawned and jump into one"

  /**
   * registerLayer is the current API; api.command.register is the deprecated v1
   * shape kept for older hosts. Register through whichever this host exposes.
   *
   * The host's command contract is {name, title, desc, category, namespace,
   * run()} - NOT {description, onSelect}. Getting that wrong is silent: the
   * entry lands outside the "palette" namespace so the palette never lists it,
   * and dispatching it calls a `run` that isn't there. `api.keymap` is typed
   * `any` here (@opentui/keymap is not a dependency and skipLibCheck is on), so
   * only a live host catches a mismatch.
   */
  const layer = api.keymap?.registerLayer?.({
    commands: [
      {
        name: COMMAND,
        title: TITLE,
        desc: DESC,
        namespace: "palette",
        run: () => {
          void open()
        },
      },
    ],
  }) as (() => void) | undefined
  const legacy = api.command?.register(() => [
    {
      title: TITLE,
      value: COMMAND,
      description: DESC,
      onSelect: () => {
        void open()
      },
    },
  ])

  api.lifecycle.onDispose(() => {
    for (const off of unsubscribe) off()
    layer?.()
    legacy?.()
  })
}

function toOption(row: ChildRow): TuiDialogSelectOption<string> {
  return {
    title: row.title || row.id,
    value: row.id,
    description: `${row.status} · ${row.id}`,
  }
}

/** "running" / "retrying" / "done", from the session's live status. */
/**
 * OpenCode's SessionStatus is only idle | busy | retry, and a session that has
 * never run has no entry at all. There is no error state to read, so a failed
 * subagent is indistinguishable from a finished one - call the settled case
 * "idle" rather than "done" so the label does not overclaim, and give the
 * never-started case its own word instead of reporting it as finished.
 */
function describeStatus(api: TuiPluginApi, sessionID: string): string {
  const status = api.state.session.status(sessionID)
  if (!status) return "queued"
  if (status.type === "busy") return "running"
  if (status.type === "retry") return "retrying"
  return "idle"
}

function readUpdatedAt(child: { time?: { updated?: number; created?: number } }): number {
  return child.time?.updated ?? child.time?.created ?? 0
}

function sameRows(a: ChildRow[], b: ChildRow[]): boolean {
  if (a.length !== b.length) return false
  return a.every((row, index) => {
    const other = b[index]
    return other !== undefined
      && row.id === other.id
      && row.title === other.title
      && row.status === other.status
  })
}

const tuiModule: TuiPluginModule = {
  id: PLUGIN_ID,
  tui: OpenWorkflowsTui,
}

export default tuiModule

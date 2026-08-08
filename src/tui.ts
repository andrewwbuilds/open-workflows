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
 * live status, the child's newest message for how its last turn ended, and
 * `route.navigate` to open one.
 *
 * KNOWN LIMITATION: TUI plugins load only in the full TUI. This viewer is not
 * reachable from `opencode run` interactive mode, which has no plugin surface.
 */
const COMMAND = "workflow.subagents"

/**
 * Cold-path fetches per refresh. `opencode attach` can point at a REMOTE
 * server, where 200 children at 100ms RTT would otherwise block the first
 * paint for seconds. Rows past the cap read "unknown" and resolve on a later
 * refresh, since each refresh re-spends the budget and resolved rows are cached.
 */
const MAX_LOOKUPS = 64
const LOOKUP_CONCURRENCY = 8
/** message.updated is chatty; each refresh costs a session.children call. */
const REFRESH_COALESCE_MS = 150

/**
 * "unknown" is the honest answer when the child's transcript could not be read
 * - it is never a stand-in for "finished". There is no "queued": a child
 * session only exists because agent() created it and immediately prompted it.
 */
type Outcome = "running" | "retrying" | "done" | "failed" | "cancelled" | "unknown"

type ChildRow = {
  id: string
  title: string
  status: Outcome
  /** Error class name for a failed row, e.g. "APIError". */
  detail?: string
  updatedAt: number
}

/**
 * The subset of an assistant message this viewer reads. Declared structurally
 * rather than imported from the v2 SDK because the two message sources hand
 * back different shapes and skipLibCheck hides version drift between the SDK
 * this repo builds against and the host that loads the plugin.
 */
type MessageInfo = {
  role?: string
  sessionID?: string
  error?: { name?: string; data?: { message?: string } }
  time?: { completed?: number }
}

export const OpenWorkflowsTui: TuiPlugin = async (api) => {
  let rows: ChildRow[] = []
  let openSessionID: string | undefined
  let ourDepth = 0
  /**
   * Settled outcomes, keyed by child id and invalidated on the child's
   * `time.updated` (or by an event that says the transcript moved). A child
   * whose last turn is over cannot change outcome without one of those.
   */
  const settled = new Map<string, { updatedAt: number; outcome: Outcome; detail?: string }>()

  const currentSessionID = (): string | undefined => {
    const route = api.route.current
    if (route.name !== "session") return undefined
    const sessionID = (route.params as { sessionID?: unknown } | undefined)?.sessionID
    return typeof sessionID === "string" ? sessionID : undefined
  }

  /**
   * Resolve every child's outcome, cheapest source first:
   *
   *   0. live session status - only busy/retry are trustworthy here (see
   *      liveStatus); everything else has to come from the transcript.
   *   1. the memoized outcome for this exact `time.updated`.
   *   2. the TUI's own message store - zero HTTP, and already holds the errored
   *      message by the time `message.updated` fires.
   *   3. one bounded `messages?limit=1` fetch, which is the only source for a
   *      workflow that ran before this TUI process started.
   */
  const load = async (sessionID: string): Promise<ChildRow[]> => {
    const response = await api.client.session.children({ sessionID })
    const children = (response.data ?? []).slice().sort((a, b) => readUpdatedAt(b) - readUpdatedAt(a))
    let budget = MAX_LOOKUPS
    const result: ChildRow[] = []
    const pending: Array<() => Promise<void>> = []
    const remember = (id: string, updatedAt: number, message: MessageInfo | undefined) => {
      const resolved = outcomeOf(message)
      // An unreadable transcript is not an outcome: caching it would freeze the
      // row on a transient failure until the child changed again.
      if (resolved.outcome !== "unknown") settled.set(id, { updatedAt, ...resolved })
      return resolved
    }
    for (const child of children) {
      const updatedAt = readUpdatedAt(child)
      const row: ChildRow = { id: child.id, title: child.title, status: "unknown", updatedAt }
      result.push(row)
      const live = liveStatus(api, child.id)
      if (live) {
        row.status = live
        continue
      }
      const cached = settled.get(child.id)
      if (cached && cached.updatedAt === updatedAt) {
        apply(row, cached)
        continue
      }
      const local = lastLocalMessage(api, child.id)
      if (local) {
        apply(row, remember(child.id, updatedAt, local))
        continue
      }
      if (budget <= 0) {
        row.status = "unknown"
        continue
      }
      budget -= 1
      pending.push(async () => {
        apply(row, remember(child.id, updatedAt, await fetchLastMessage(api, child.id)))
      })
    }
    await runBounded(pending, LOOKUP_CONCURRENCY)
    return result
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

  /**
   * At most one refresh per REFRESH_COALESCE_MS. `message.updated` fires per
   * step of every child, and an un-throttled refresh costs a session.children
   * call each time.
   */
  let refreshTimer: ReturnType<typeof setTimeout> | undefined
  const scheduleRefresh = (): void => {
    if (refreshTimer !== undefined) return
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined
      refresh()
    }, REFRESH_COALESCE_MS)
  }

  /**
   * Drop the memoized outcome for a child whose transcript just moved, then
   * refresh.
   *
   * `session.idle` is NOT enough on its own: on a failing child the live event
   * order is session.error -> session.status idle -> session.idle ->
   * message.updated(assistant, error), so the error reaches the MESSAGE only
   * after idle and an idle-triggered read paints "done" for one beat.
   * `session.error` is only ever an invalidate hint, never a verdict - the
   * engine re-prompts in-session, so an error event can be followed by a
   * success. The child's newest message stays the single source of truth.
   */
  const invalidate = (sessionID: string | undefined): void => {
    if (sessionID) settled.delete(sessionID)
    scheduleRefresh()
  }

  const unsubscribe = [
    api.event.on("session.updated", () => scheduleRefresh()),
    api.event.on("session.status", () => scheduleRefresh()),
    api.event.on("session.idle", () => scheduleRefresh()),
    api.event.on("message.updated", (event) => {
      const properties = event.properties as { sessionID?: string; info?: MessageInfo }
      invalidate(properties.sessionID ?? properties.info?.sessionID)
    }),
    api.event.on("session.error", (event) => {
      invalidate((event.properties as { sessionID?: string }).sessionID)
    }),
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
    if (refreshTimer !== undefined) clearTimeout(refreshTimer)
    layer?.()
    legacy?.()
  })
}

function toOption(row: ChildRow): TuiDialogSelectOption<string> {
  return {
    title: row.title || row.id,
    value: row.id,
    description: `${row.status}${row.detail ? ` · ${row.detail}` : ""} · ${row.id}`,
  }
}

function apply(row: ChildRow, resolved: { outcome: Outcome; detail?: string }): void {
  row.status = resolved.outcome
  row.detail = resolved.detail
}

/**
 * The only outcomes the live session status can settle on its own.
 *
 * OpenCode's SessionStatus is idle | busy | retry, so "idle" says a turn is
 * over but not whether it succeeded, and a child this TUI process never watched
 * run has NO status entry at all - which used to render as "queued" for every
 * subagent of a workflow that predates the TUI. Both cases return undefined
 * here, meaning "ask the stored message", not "queued".
 */
function liveStatus(api: TuiPluginApi, sessionID: string): Outcome | undefined {
  const status = api.state.session.status(sessionID)
  if (status?.type === "busy") return "running"
  if (status?.type === "retry") return "retrying"
  return undefined
}

/**
 * The child's newest message from the TUI's own store - no HTTP, and already
 * populated by the time `message.updated` fires for that child.
 *
 * This source yields FLAT Message objects; the client source below yields
 * `{ info, parts }` wrappers. Reading one as the other silently produces
 * "unknown" for every row.
 */
function lastLocalMessage(api: TuiPluginApi, sessionID: string): MessageInfo | undefined {
  // Guarded like api.command: an older host may not expose it.
  const read = api.state.session.messages as ((id: string) => ReadonlyArray<unknown>) | undefined
  if (typeof read !== "function") return undefined
  const messages = read(sessionID)
  return (messages[messages.length - 1] as MessageInfo | undefined) ?? undefined
}

/** One bounded read for a child the TUI never watched; `limit` returns the newest. */
async function fetchLastMessage(api: TuiPluginApi, sessionID: string): Promise<MessageInfo | undefined> {
  try {
    const response = await api.client.session.messages({ sessionID, limit: 1 })
    const messages = response.data ?? []
    return messages[messages.length - 1]?.info as MessageInfo | undefined
  } catch {
    // A child whose transcript cannot be read reports "unknown" rather than
    // taking the whole dialog down.
    return undefined
  }
}

/**
 * What a child's newest message says about its last turn.
 *
 * OpenCode persists `info.error` on the stored assistant message (verified live
 * against 1.15.10), which is the only readable failure signal: `Session.metadata`
 * is declared by the SDK and accepted by PATCH but silently dropped by the
 * server, so a workflow-written side channel would read back null forever.
 */
function outcomeOf(message: MessageInfo | undefined): { outcome: Outcome; detail?: string } {
  if (!message) return { outcome: "unknown" }
  // The prompt is stored before the assistant turn opens.
  if (message.role !== "assistant") return { outcome: "running" }
  const name = message.error?.name
  if (name) return { outcome: name === "MessageAbortedError" ? "cancelled" : "failed", detail: name }
  if (message.time?.completed === undefined) return { outcome: "running" }
  return { outcome: "done" }
}

/** Run thunks with at most `limit` in flight. */
async function runBounded(thunks: Array<() => Promise<void>>, limit: number): Promise<void> {
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next
      next += 1
      const thunk = thunks[index]
      if (!thunk) return
      await thunk()
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, thunks.length) }, worker))
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
      && row.detail === other.detail
  })
}

const tuiModule: TuiPluginModule = {
  id: PLUGIN_ID,
  tui: OpenWorkflowsTui,
}

export default tuiModule

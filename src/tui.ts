import type {
  TuiAttentionNotifyInput,
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

/**
 * Phases the orchestrator and engine write into child session titles. Only
 * children whose title starts with one of these prefixes are surfaced by the
 * auto-open / notification path - non-workflow children are not "subagents of
 * the workflow" in any sense the user can act on.
 */
type WorkflowPhase = "Plan" | "Work" | "Review"

const PHASE_PREFIXES: Array<{ phase: WorkflowPhase; prefix: string }> = [
  { phase: "Plan", prefix: "Workflow planner" },
  { phase: "Review", prefix: "Workflow reviewer" },
  { phase: "Work", prefix: "Workflow worker" },
]

function classifyTitle(title: string): WorkflowPhase | undefined {
  for (const entry of PHASE_PREFIXES) {
    if (title.startsWith(entry.prefix)) return entry.phase
  }
  return undefined
}

type ChildRow = {
  id: string
  title: string
  status: Outcome
  /** Error class name for a failed row, e.g. "APIError". */
  detail?: string
  updatedAt: number
  phase?: WorkflowPhase
  /**
   * One-line tail of the child's most recent assistant reply. Cached per
   * (sessionID, messageID) so a dialog refresh that hits the local message
   * store does not re-fetch. Undefined until the row has been resolved
   * against the HTTP transcript at least once.
   */
  preview?: string
}

/**
 * Per-child remembered state used by the activity watcher to detect
 * transitions - the only reason to keep it is so we can fire the
 * attention.notify() + toast the moment a child settles.
 */
type WatchedChild = {
  id: string
  title: string
  phase?: WorkflowPhase
  /** Last status the watcher observed; undefined until the first observation. */
  lastStatus?: Outcome
}

/**
 * Per-session tracker. The TUI plugin auto-opens the workflow dialog when a
 * workflow child appears under the active session; tracking dismissed state
 * per session stops a dismissed dialog from immediately popping back up.
 */
type SessionState = {
  /**
   * Children observed so far under this session, regardless of whether the
   * dialog is open. Lets us detect "first workflow child appeared" for
   * auto-open and "this child just settled" for notifications.
   */
  children: Map<string, WatchedChild>
  /**
   * True once the user closed the workflow dialog during an active workflow.
   * Cleared when the workflow finishes (all workflow children are settled).
   */
  dismissed: boolean
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
  /**
   * Per-session activity tracking - separate from the dialog state so the
   * dialog can be closed without losing the watcher, and so the watcher can
   * notice children appearing in a session whose dialog was never opened.
   */
  const sessions = new Map<string, SessionState>()

  const currentSessionID = (): string | undefined => {
    const route = api.route.current
    if (route.name !== "session") return undefined
    const sessionID = (route.params as { sessionID?: unknown } | undefined)?.sessionID
    return typeof sessionID === "string" ? sessionID : undefined
  }

  const sessionState = (id: string): SessionState => {
    let state = sessions.get(id)
    if (!state) {
      state = { children: new Map(), dismissed: false }
      sessions.set(id, state)
    }
    return state
  }

  /**
   * Per-message text tail cache. Keyed by messageID so a row whose newest
   * message is unchanged reuses the prior tail without another HTTP round
   * trip. Invalidated implicitly when the message id changes (a child that
   * produced a new assistant turn gets a new id).
   */
  const previewByMessage = new Map<string, string>()
  /** Last-seen message id per row, for cache lookup on the warm path. */
  const messageIDByRow = new Map<string, string>()

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
   *
   * Text previews follow the same escalation: served from the cache for rows
   * we have already cold-fetched once, otherwise extracted from the same HTTP
   * fetch that resolves the outcome.
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
      const row: ChildRow = {
        id: child.id,
        title: child.title,
        status: "unknown",
        updatedAt,
        phase: classifyTitle(child.title),
      }
      result.push(row)
      // Live session status is the most authoritative signal: "busy" means
      // a turn is in flight and overrides any stale "failed" we previously
      // memoized from a stored message (the engine re-prompts in-session on
      // a recoverable error, so the cached outcome can be wrong).
      const live = liveStatus(api, child.id)
      if (live) {
        row.status = live
      } else {
        const cachedOutcome = settled.get(child.id)
        const outcomeFresh = cachedOutcome && cachedOutcome.updatedAt === updatedAt
        if (outcomeFresh) apply(row, cachedOutcome)
        const local = lastLocalMessage(api, child.id)
        if (local) apply(row, remember(child.id, updatedAt, local))
      }
      // Preview: paint from cache whenever the row already has a message id
      // we have seen before - covers cold rows revisited by later ticks.
      const knownMessageID = messageIDByRow.get(child.id)
      if (knownMessageID) {
        const cachedTail = previewByMessage.get(knownMessageID)
        if (cachedTail) row.preview = cachedTail
      }
      // Cold path: full HTTP fetch resolves outcome + tail in one call.
      const localResolved = !!lastLocalMessage(api, child.id)
      const cachedResolved = !!(settled.get(child.id)?.updatedAt === updatedAt)
      const needColdFetch = !live && !cachedResolved && !localResolved
      if (!needColdFetch) continue
      if (budget <= 0) continue
      budget -= 1
      pending.push(async () => {
        const fetched = await fetchLastMessage(api, child.id)
        apply(row, remember(child.id, updatedAt, fetched.info))
        if (fetched.messageID && fetched.tail) {
          previewByMessage.set(fetched.messageID, fetched.tail)
          messageIDByRow.set(child.id, fetched.messageID)
          row.preview = fetched.tail
        }
      })
    }
    await runBounded(pending, LOOKUP_CONCURRENCY)
    return result
  }

  /**
   * Render the workflow dialog. The title carries a phase summary so a glance
   * tells the user where the workflow is without expanding any row: "Plan
   * 1 running · Work 2 done, 1 running · Review -". A user who wants the row
   * list still gets it.
   */
  const render = (): void => {
    api.ui.dialog.replace(() =>
      api.ui.DialogSelect<string>({
        title: dialogTitle(rows),
        placeholder: rows.length > 0 ? "Filter subagents" : "No workflow subagents in this session",
        options: rows.map(toOption),
        onSelect: (option) => {
          api.ui.dialog.clear()
          api.route.navigate("session", { sessionID: option.value })
        },
      }),
    )
  }

  const open = async (initial?: ChildRow[]): Promise<void> => {
    const sessionID = currentSessionID()
    if (!sessionID) {
      api.ui.toast({
        variant: "info",
        message: "Open a session first - subagents are listed per session.",
      })
      return
    }
    // When called from the auto-open path the watcher has already loaded the
    // children; reuse them so the dialog paints without a second round-trip.
    const next = initial ?? await load(sessionID).catch(() => rows)
    if (next !== rows) rows = next
    openSessionID = sessionID
    // A manual open counts as a fresh start: clear the dismissed flag so the
    // watcher does not auto-close on the next transition.
    sessionState(sessionID).dismissed = false
    render()
    // Remember how deep our dialog sits so refresh can tell "our dialog is
    // still up" from "the user opened the model picker on top of it".
    ourDepth = api.ui.dialog.depth
  }

  // Live refresh: a single coalesced fetch feeds both the dialog and the
  // activity watcher. The dialog reads the latest rows from `rows`; the
  // watcher tracks per-child transitions for notifications and auto-open.
  // Running them through one fetch keeps the burst-coalescing invariant the
  // previous single-purpose refresh path had (one HTTP round-trip per coalesce
  // window, not two).
  const refresh = async (): Promise<void> => {
    refreshTimer = undefined
    const sessionID = currentSessionID()
    if (!sessionID) return
    // Settle dismissal state BEFORE the watcher runs, otherwise a watcher
    // observing a freshly-appeared workflow child would auto-open the dialog
    // that the user just dismissed in the previous refresh window.
    tickDialogDismissal(sessionID)
    let next: ChildRow[]
    try {
      next = await load(sessionID)
    } catch {
      return
    }
    updateWatchers(sessionID, next)
    // Only re-render the dialog if it is open AND pointing at the session we
    // just fetched. openSessionID is set only by open() and cleared by
    // tickDialogDismissal above; without this gate, a session switch while
    // the dialog was open would render stale rows into the dialog.
    if (openSessionID !== sessionID) return
    if (!ours()) return
    if (sameRows(rows, next)) return
    rows = next
    render()
  }

  /** True only while OUR dialog is the frontmost one. */
  const ours = (): boolean =>
    openSessionID !== undefined && api.ui.dialog.open && api.ui.dialog.depth === ourDepth

  /**
   * If the dialog was dismissed since the last refresh, mark its session as
   * dismissed so the watcher's auto-open gate rejects the next appearance.
   * Must run BEFORE updateWatchers in the same refresh tick.
   */
  const tickDialogDismissal = (sessionID: string): void => {
    if (!openSessionID) return
    if (api.ui.dialog.open) return
    // The user closed our dialog. Drop openSessionID and remember the
    // dismissal against the session that owned it (which may differ from
    // currentSessionID() if the user navigated between events).
    const closingID = openSessionID
    openSessionID = undefined
    if (closingID) sessionState(closingID).dismissed = true
    void sessionID
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
      void refresh()
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

  /**
   * Update the activity tracker for one session with a freshly-loaded child
   * list. Fires attention.notify and toasts when a child settles, and
   * auto-opens the dialog on the first workflow child appearing in an
   * undismissed session.
   */
  const updateWatchers = (sessionID: string, next: ChildRow[]): void => {
    const state = sessionState(sessionID)
    let anyWorkflowChild = false
    let anyRunning = false
    let firstObserved = false
    for (const row of next) {
      const phase = row.phase ?? classifyTitle(row.title)
      if (!phase) continue
      anyWorkflowChild = true
      const previous = state.children.get(row.id)
      if (!previous) {
        firstObserved = true
        state.children.set(row.id, { id: row.id, title: row.title, phase, lastStatus: row.status })
        continue
      }
      // Settle notification fires on every transition into a terminal state -
      // the dedupe comes from the host's "subagent_done" sound being idempotent
      // and from the watcher's "lastStatus" snapshot only triggering on change.
      if (isTerminal(row.status) && previous.lastStatus !== row.status) {
        notifyChildSettled(row)
      } else if (row.status === "running" || row.status === "retrying") {
        anyRunning = true
      }
      previous.lastStatus = row.status
      previous.phase = phase
      previous.title = row.title
    }
    // Garbage-collect children that no longer exist (e.g. a session that has
    // been deleted). The list endpoint only returns live children, so anything
    // missing from `next` is gone.
    const liveIDs = new Set(next.map((row) => row.id))
    for (const id of [...state.children.keys()]) {
      if (!liveIDs.has(id)) state.children.delete(id)
    }
    if (!anyWorkflowChild) {
      // Workflow has ended (or never existed) - reset dismissed so a fresh
      // workflow in the same session will auto-open the dialog again.
      state.dismissed = false
      state.children.clear()
    } else if (firstObserved && !state.dismissed && sessionID === currentSessionID()) {
      // First workflow child of this workflow just appeared under the active
      // session, and the user has not dismissed the dialog - pop it open.
      void open(next)
    } else if (!anyRunning && anyWorkflowChild && state.children.size > 0) {
      notifyWorkflowComplete(state)
    }
  }

  /**
   * Fire a one-shot sound + OS notification when a workflow child settles.
   * The OpenCode `subagent_done` sound (see TuiAttentionSoundNames in
   * @opencode-ai/plugin/tui) is the host-bundled cue for exactly this event;
   * `when: "always"` plays the sound regardless of focus so a user who
   * switched tabs to read the planner output still hears the worker finish.
   */
  const notifyChildSettled = (row: ChildRow): void => {
    const label = row.title || row.id
    const variant = row.status === "failed" ? "error" : row.status === "cancelled" ? "warning" : "success"
    api.ui.toast({
      variant,
      message: `${label}: ${row.status}${row.detail ? ` (${row.detail})` : ""}`,
    })
    if (!api.attention?.notify) return
    const input: TuiAttentionNotifyInput = {
      title: "Workflow subagent",
      message: `${label} ${row.status}`,
      notification: true,
      sound: { name: "subagent_done", when: "always" },
    }
    void api.attention.notify(input).catch(() => {
      // Attention is best-effort - missing the OS notification must not block
      // the rest of the workflow UI.
    })
  }

  /**
   * One final toast when an entire workflow wraps. Only fires if the watcher
   * already had children observed - a session whose workflow completed before
   * the TUI plugin attached does not get a delayed "done" notice.
   */
  const notifyWorkflowComplete = (state: SessionState): void => {
    if (state.children.size === 0) return
    api.ui.toast({
      variant: "info",
      message: `Workflow complete (${state.children.size} subagent${state.children.size === 1 ? "" : "s"})`,
    })
    state.children.clear()
  }

  /**
   * Watch every relevant session whenever anything changes: a session.updated
   * fires for any session, including children we did not create, but the
   * children list is what we need, and that fetch already runs as part of
   * refresh() above. The watcher reads `next` directly, so events for
   * non-active sessions are simply no-ops until the user navigates there.
   */
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
  const description = `${row.status}${row.detail ? ` · ${row.detail}` : ""} · ${row.id}`
  const option: TuiDialogSelectOption<string> = {
    title: row.title || row.id,
    value: row.id,
    description,
  }
  // The footer carries the inline preview when we have one. The host renders
  // it under the row's description so a user can read the worker's last reply
  // without navigating into the child session.
  if (row.preview) option.footer = row.preview
  return option
}

/**
 * Phase summary for the dialog title. Counts workflow children whose phase
 * was classified by `classifyTitle`; non-workflow children are not part of the
 * summary even though they still appear as rows.
 */
function dialogTitle(rows: ChildRow[]): string {
  const summary = new Map<WorkflowPhase, { running: number; done: number; failed: number }>()
  for (const row of rows) {
    if (!row.phase) continue
    let bucket = summary.get(row.phase)
    if (!bucket) {
      bucket = { running: 0, done: 0, failed: 0 }
      summary.set(row.phase, bucket)
    }
    if (row.status === "running" || row.status === "retrying") bucket.running += 1
    else if (row.status === "done") bucket.done += 1
    else if (row.status === "failed" || row.status === "cancelled") bucket.failed += 1
  }
  if (summary.size === 0) return "Workflow subagents"
  const parts: string[] = []
  for (const phase of ["Plan", "Work", "Review"] as const) {
    const bucket = summary.get(phase)
    if (!bucket) continue
    const counts: string[] = []
    if (bucket.running > 0) counts.push(`${bucket.running} running`)
    if (bucket.done > 0) counts.push(`${bucket.done} done`)
    if (bucket.failed > 0) counts.push(`${bucket.failed} failed`)
    parts.push(counts.length > 0 ? `${phase} ${counts.join(", ")}` : phase)
  }
  return `Workflow subagents · ${parts.join(" · ")}`
}

function isTerminal(status: Outcome): boolean {
  return status === "done" || status === "failed" || status === "cancelled"
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

interface FetchedMessage {
  info: MessageInfo | undefined
  /**
   * Stable identifier of the message the tail came from, used to cache the
   * tail so subsequent refresh ticks can avoid re-fetching the same turn.
   */
  messageID?: string
  /** Last text part of the assistant message, collapsed onto one line. */
  tail?: string
}

/** Cap on the inline preview so a chatty worker cannot blow up the dialog. */
const PREVIEW_MAX = 140

/** One bounded read for a child the TUI never watched; `limit` returns the newest. */
async function fetchLastMessage(
  api: TuiPluginApi,
  sessionID: string,
): Promise<FetchedMessage> {
  try {
    const response = await api.client.session.messages({ sessionID, limit: 1 })
    const messages = response.data ?? []
    const last = messages[messages.length - 1]
    if (!last) return { info: undefined }
    const info = last.info as (MessageInfo & { id?: string }) | undefined
    const tail = extractTail(last.parts)
    return {
      info,
      messageID: typeof info?.id === "string" ? info.id : undefined,
      tail,
    }
  } catch {
    // A child whose transcript cannot be read reports "unknown" rather than
    // taking the whole dialog down.
    return { info: undefined }
  }
}

/**
 * Walk the parts of a message backwards, skipping tool-call and step-bookkeep
 * boundaries, and return the trailing run of text collapsed onto one line.
 *
 * A worker turn that used tools emits narration text around each tool call;
 * joining every text part would return "Let me check ... here's what I found"
 * concatenated. The trailing run is the worker's final answer.
 */
function extractTail(parts: unknown): string | undefined {
  if (!Array.isArray(parts) || parts.length === 0) return undefined
  // Strip trailing step-finish / step-start parts; they carry no answer text.
  let end = parts.length
  while (end > 0) {
    const type = (parts[end - 1] as { type?: unknown })?.type
    if (type === "step-start" || type === "step-finish") end -= 1
    else break
  }
  // Walk back to the first non-text boundary (a tool call or step marker)
  // and join everything after it. Mirrors the server-side `collectText` in
  // sdk.ts so the dialog preview matches the value the engine returned.
  let start = 0
  for (let index = end - 1; index >= 0; index -= 1) {
    const type = (parts[index] as { type?: unknown })?.type
    if (type === "text") continue
    start = index + 1
    break
  }
  const text: string[] = []
  for (let index = start; index < end; index += 1) {
    const part = parts[index] as { type?: unknown; text?: unknown }
    if (part.type === "text" && typeof part.text === "string") text.push(part.text)
  }
  const joined = text.join(" ").replace(/\s+/g, " ").trim()
  if (!joined) return undefined
  return joined.length > PREVIEW_MAX ? `${joined.slice(0, PREVIEW_MAX - 1)}\u2026` : joined
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

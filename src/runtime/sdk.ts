import type { Part, TextPart } from "@opencode-ai/sdk"
import type { createOpencodeClient } from "@opencode-ai/sdk"
import type { CreateChildSessionInput, RunChildSessionInput, RunChildSessionResult, SessionRunner } from "./types.js"

export type OpencodeClientLike = ReturnType<typeof createOpencodeClient>

/**
 * `variant` and `format` are accepted and validated by
 * POST /session/{id}/message (the server's own OpenAPI declares both), but they
 * are missing from the v1 SDK's generated body type, which lags the v2 one.
 * Widen the literal so the fields type-check; the client forwards the body
 * verbatim, so they reach the wire.
 *
 * `format.retryCount` is deliberately NOT sent. OpenCode 1.15 declares it with
 * a decoding default of 2 but references it nowhere: a structured-output miss
 * is reported as a terminal error with `retries: 0` after exactly one model
 * turn. Sending it would look like a retry budget while providing none, and
 * would double up with the engine's own in-session retry loop if OpenCode ever
 * wires it. The engine owns retries; see runSession in script/engine.ts.
 */
type PromptBody = NonNullable<
  Parameters<OpencodeClientLike["session"]["prompt"]>[0]["body"]
> & {
  variant?: string
  format?: { type: "json_schema"; schema: Record<string, unknown> }
}

export function createSdkRunner(
  opencodeClient: OpencodeClientLike,
  parentSessionID: string,
  options: { directory?: string } = {},
): SessionRunner {
  return new SdkRunner(opencodeClient, parentSessionID, options.directory)
}

class SdkRunner implements SessionRunner {
  private readonly client: OpencodeClientLike
  private readonly parentSessionID: string
  private readonly directory: string | undefined
  /** Memoized parent-session model; the wrapper distinguishes "unresolved" from "resolved to undefined". */
  private parentModel: { value: string | undefined } | undefined
  /** Memoized "provider/model-id" -> variant ids; the catalogue is fetched at most once. */
  private variantTable: Promise<Map<string, string[]> | undefined> | undefined
  /** Memoized agent-name registry; fetched at most once per run. */
  private agentNames: Promise<string[] | undefined> | undefined
  /**
   * Memoized parent-session transcript. resolveParentModel and
   * readTurnOutputTokens both walk it and both run once at the start of a
   * workflow, so sharing the fetch halves a round trip on a response big
   * enough that loadVariants is deliberately lazy for the same reason.
   */
  private messageList: Promise<unknown[] | undefined> | undefined
  /**
   * Cumulative output tokens already observed per child session, so each prompt
   * can report its own turn as a delta. See runChildSession for why the
   * returned message is not the whole turn.
   */
  private readonly sessionOutput = new Map<string, number>()

  constructor(client: OpencodeClientLike, parentSessionID: string, directory: string | undefined) {
    this.client = client
    this.parentSessionID = parentSessionID
    this.directory = directory
  }

  async createChildSession(input: CreateChildSessionInput): Promise<{ sessionID: string }> {
    const directory = input.directory ?? this.directory
    const created = await this.client.session.create({
      query: directory ? { directory } : undefined,
      body: { parentID: this.parentSessionID, title: childSessionTitle(input) },
    })
    const session = unwrap(created)
    return { sessionID: session.id }
  }

  async runChildSession(input: RunChildSessionInput): Promise<RunChildSessionResult> {
    const directory = input.directory ?? this.directory
    const query = directory ? { directory } : undefined
    const response = await this.client.session.prompt({
      path: { id: input.sessionID },
      query,
      ...(input.abort ? { signal: input.abort } : {}),
      body: {
        agent: input.agent,
        ...(input.model ? { model: parseModel(input.model) } : {}),
        ...(input.noReply ? { noReply: true } : {}),
        ...(input.variant ? { variant: input.variant } : {}),
        ...(input.system ? { system: input.system } : {}),
        ...(input.schema
          ? { format: { type: "json_schema" as const, schema: input.schema as Record<string, unknown> } }
          : {}),
        parts: [{ type: "text", text: input.prompt }],
      } as PromptBody,
    })
    const message = unwrap(response)
    const info = message.info as {
      structured?: unknown
      // The wire shape is `{ name, data: { message } }`; reading `.message` off
      // the error directly (as this did) always yielded undefined, which made
      // every StructuredOutputError and APIError look like an empty success.
      error?: { name?: string; data?: { message?: string } }
      finish?: string
      tokens?: { input?: number; output?: number }
    }
    const error = info.error
    return {
      text: collectText(message.parts),
      structured: info.structured,
      error: error ? (error.data?.message ?? error.name ?? "child session failed") : undefined,
      errorName: error?.name,
      sessionID: input.sessionID,
      finish: info.finish,
      tokens: {
        input: info.tokens?.input,
        output: await this.turnOutput(input.sessionID, info.tokens?.output),
      },
    }
  }

  /**
   * Output tokens THIS prompt burned, as a delta on the child session's
   * cumulative total.
   *
   * A subagent turn that uses tools is stored by OpenCode as one assistant
   * message PER STEP, and POST /session/{id}/message returns only the LAST of
   * them. Reading `info.tokens.output` off that message therefore credits a
   * single step and hides every earlier one, so `budgetTokens` under-counted by
   * the number of tool-call rounds - a 20-step subagent spent 20x its ceiling
   * without the budget ever tripping. `GET /session/{id}` reports the session's
   * already-committed aggregate and is up to date the instant the POST
   * resolves, so the delta since the previous prompt is the real turn cost.
   * Deltas (not the raw total) because the schema-retry loop prompts the same
   * session more than once.
   *
   * `input` is deliberately left as the returned message's: per-step input
   * tokens re-count the whole context, so a session-level input aggregate is
   * not a turn cost. Nothing reads it; only `output` feeds the budget.
   */
  private async turnOutput(sessionID: string, fallback: number | undefined): Promise<number | undefined> {
    const total = await this.readSessionOutput(sessionID)
    if (total === undefined) return fallback
    const previous = this.sessionOutput.get(sessionID) ?? 0
    this.sessionOutput.set(sessionID, total)
    return Math.max(0, total - previous)
  }

  /** The child session's cumulative output tokens; undefined when unreadable. */
  private async readSessionOutput(sessionID: string): Promise<number | undefined> {
    try {
      // `tokens` postdates the v1 SDK's generated Session type; the live server
      // sends it. Fall back to the message's own count rather than failing a
      // run on a host that does not.
      const session = unwrap(await this.client.session.get({ path: { id: sessionID } })) as {
        tokens?: { output?: number }
      }
      const output = session.tokens?.output
      return typeof output === "number" ? output : undefined
    } catch {
      return undefined
    }
  }

  async abortSession(sessionID: string): Promise<void> {
    try {
      await this.client.session.abort({ path: { id: sessionID } })
    } catch {
      // A child that cannot be stopped must not turn a cancelled run into a
      // crashed one; it is already being reported as aborted.
    }
  }

  async deleteSession(sessionID: string): Promise<void> {
    try {
      await this.client.session.delete({ path: { id: sessionID } })
    } catch {
      // Ignore deletion errors so the workflow does not leak interruptions.
    }
  }

  /**
   * Read the model the parent session is actually running on by walking its
   * messages back to the most recent assistant turn. That reflects the model
   * the user selected in the TUI, including a mid-session switch, which the
   * config-level default does not. Resolved once per workflow run.
   */
  async resolveParentModel(): Promise<string | undefined> {
    if (this.parentModel !== undefined) return this.parentModel.value
    let value: string | undefined
    const messages = (await this.loadMessages()) ?? []
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const info = (messages[index] as { info?: unknown } | undefined)?.info as
        | { role?: string; providerID?: string; modelID?: string }
        | undefined
      if (info?.role !== "assistant") continue
      if (!info.providerID || !info.modelID) continue
      value = `${info.providerID}/${info.modelID}`
      break
    }
    this.parentModel = { value }
    return value
  }

  /**
   * Output tokens already committed by the parent's CURRENT turn. See
   * SessionRunner.readTurnOutputTokens for why this is a lower bound; undefined
   * means the turn could not be found at all, which is different from a real 0.
   *
   * A turn spans every assistant message since the last user message, not just
   * `messageID`: OpenCode opens a new assistant message per step, so a main
   * loop that called two tools before this one has already left its output on
   * messages this id does not match. Summing back to the user message counts
   * all of them.
   */
  async readTurnOutputTokens(messageID: string): Promise<number | undefined> {
    const messages = await this.loadMessages()
    if (!messages) return undefined
    let total = 0
    let found = false
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const info = (messages[index] as { info?: unknown } | undefined)?.info as
        | { id?: string; role?: string; tokens?: { output?: number } }
        | undefined
      if (info?.role === "user") break
      if (info?.id === messageID) found = true
      total += info?.tokens?.output ?? 0
    }
    return found ? total : undefined
  }

  /** The parent session's messages, fetched at most once; undefined on failure. */
  private loadMessages(): Promise<unknown[] | undefined> {
    this.messageList ??= (async () => {
      try {
        return unwrap(await this.client.session.messages({ path: { id: this.parentSessionID } }))
      } catch {
        // Never fail a run over an unreadable transcript: callers fall back to
        // OpenCode's default model and to a zero token seed.
        return undefined
      }
    })()
    return this.messageList
  }

  async listModelVariants(model: string): Promise<string[] | undefined> {
    this.variantTable ??= this.loadVariants()
    return (await this.variantTable)?.get(model)
  }

  /**
   * Agent names from /app/agents, memoized for the run. Returns undefined when
   * the registry cannot be read or comes back empty, so callers fall back to
   * passing the requested agent through unchecked rather than failing a run on
   * an unreadable catalogue.
   */
  async listAgents(): Promise<string[] | undefined> {
    this.agentNames ??= (async () => {
      try {
        const agents = unwrap(await this.client.app.agents())
        const names = agents.map((entry) => entry.name).filter((name) => typeof name === "string")
        return names.length > 0 ? names : undefined
      } catch {
        return undefined
      }
    })()
    return this.agentNames
  }

  /**
   * Index every model's declared reasoning variants from /config/providers.
   * The response is large, so it is fetched lazily - only once some agent()
   * call actually asks for an effort - and memoized for the run.
   */
  private async loadVariants(): Promise<Map<string, string[]> | undefined> {
    try {
      const response = await this.client.config.providers()
      const data = unwrap(response)
      const table = new Map<string, string[]>()
      for (const provider of data.providers) {
        for (const [modelID, info] of Object.entries(provider.models)) {
          // `variants` postdates the v1 SDK's generated Model type.
          const variants = (info as { variants?: Record<string, unknown> }).variants
          table.set(`${provider.id}/${modelID}`, Object.keys(variants ?? {}))
        }
      }
      return table
    } catch {
      // An unreadable catalogue must not fail the workflow: report "unknown"
      // and let the caller send the requested variant unchecked.
      return undefined
    }
  }
}

export function parseModel(model: string): { providerID: string; modelID: string } {
  const slash = model.indexOf("/")
  if (slash <= 0 || slash === model.length - 1) {
    throw new Error(
      `Invalid model "${model}". Expected "provider/model-id" (e.g. "anthropic/claude-sonnet-4-5").`,
    )
  }
  return {
    providerID: model.slice(0, slash),
    modelID: model.slice(slash + 1),
  }
}

function unwrap<T>(result: { data?: T; error?: unknown }): T {
  if (result.error) {
    const message = (result.error as { data?: { message?: string }; message?: string }).data?.message
      ?? (result.error as { message?: string }).message
      ?? "OpenCode SDK request failed"
    throw new Error(message)
  }
  if (result.data === undefined || result.data === null) {
    throw new Error("OpenCode SDK returned no data")
  }
  return result.data
}

/**
 * The subagent's FINAL text, which is what agent() returns.
 *
 * An assistant turn that used tools emits narration text around each tool call
 * in the same message; joining every text part would hand the script "Let me
 * check the tests..." concatenated with the answer. So when the message
 * contains any non-text part, only the trailing run of text parts - everything
 * after the last tool/step boundary - counts. Messages with no tool parts join
 * all their text, which is the single-answer case.
 */
function collectText(parts: Part[]): string {
  const relevant = parts.filter((part) => isTextPart(part) || isBoundaryPart(part))
  // Every real OpenCode assistant message ends with a step-finish, so the
  // answer is not the tail of the array. Walk trailing step markers off first;
  // scanning for the boundary from the very end would always stop on that
  // step-finish and return "" for every message the server actually sends.
  // Only step markers are stripped - a turn that ends on a *tool* call really
  // did stop without answering, and must still come back empty.
  let end = relevant.length
  while (end > 0 && isStepPart(relevant[end - 1] as Part)) end -= 1
  let start = 0
  for (let index = end - 1; index >= 0; index -= 1) {
    if (!isTextPart(relevant[index] as Part)) {
      start = index + 1
      break
    }
  }
  const text: string[] = []
  for (const part of relevant.slice(start, end)) {
    if (isTextPart(part)) text.push(part.text)
  }
  return text.join("\n")
}

function isTextPart(part: Part): part is TextPart {
  return (part as { type?: string }).type === "text"
}

/** Parts that end a narration run: a tool call or an explicit step boundary. */
function isBoundaryPart(part: Part): boolean {
  const type = (part as { type?: string }).type
  return type === "tool" || isStepPart(part)
}

/** Step bookkeeping the server emits around each step; carries no answer text. */
function isStepPart(part: Part): boolean {
  const type = (part as { type?: string }).type
  return type === "step-start" || type === "step-finish"
}

/**
 * Compose a child session's title as "<phase> · <label>".
 *
 * This is the only child-session field any native OpenCode surface renders: the
 * session list, and the `opencode run` subagent panel's bootstrap path, which
 * makes a tab from a child session's title when that child is blocked on a
 * permission or question at attach time. See src/tui.ts for why the panel
 * cannot be reached any other way.
 */
export function childSessionTitle(input: { title: string; phase?: string }): string {
  const phase = input.phase?.trim()
  return phase ? `${phase} · ${input.title}` : input.title
}

import type { Part, TextPart } from "@opencode-ai/sdk"
import type { createOpencodeClient } from "@opencode-ai/sdk"
import type { CreateChildSessionInput, RunChildSessionInput, RunChildSessionResult, SessionRunner } from "./types.js"

export type OpencodeClientLike = ReturnType<typeof createOpencodeClient>

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

  constructor(client: OpencodeClientLike, parentSessionID: string, directory: string | undefined) {
    this.client = client
    this.parentSessionID = parentSessionID
    this.directory = directory
  }

  async createChildSession(input: CreateChildSessionInput): Promise<{ sessionID: string }> {
    const directory = input.directory ?? this.directory
    const created = await this.client.session.create({
      query: directory ? { directory } : undefined,
      body: { parentID: this.parentSessionID, title: input.title },
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
        parts: [{ type: "text", text: input.prompt }],
      },
    })
    const message = unwrap(response)
    const text = collectText(message.parts)
    const error = (message.info as { error?: { message?: string; name?: string } }).error
    const finish = (message.info as { finish?: string }).finish
    const tokens = (message.info as { tokens?: { input?: number; output?: number } }).tokens
    return {
      text,
      error: error?.message,
      sessionID: input.sessionID,
      finish,
      tokens: tokens ? { input: tokens.input, output: tokens.output } : undefined,
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
    try {
      const response = await this.client.session.messages({
        path: { id: this.parentSessionID },
      })
      const messages = unwrap(response)
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const info = messages[index]?.info as
          | { role?: string; providerID?: string; modelID?: string }
          | undefined
        if (info?.role !== "assistant") continue
        if (!info.providerID || !info.modelID) continue
        value = `${info.providerID}/${info.modelID}`
        break
      }
    } catch {
      // Fall back to OpenCode's own default model rather than failing the run.
    }
    this.parentModel = { value }
    return value
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

function collectText(parts: Part[]): string {
  const text: string[] = []
  for (const part of parts) {
    if (isTextPart(part)) {
      text.push(part.text)
    }
  }
  return text.join("\n")
}

function isTextPart(part: Part): part is TextPart {
  return (part as { type?: string }).type === "text"
}

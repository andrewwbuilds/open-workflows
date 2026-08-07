import type { OpencodeClient } from "@opencode-ai/sdk"
import type { JsonSchemaLike } from "../script/schema.js"

export interface CreateChildSessionInput {
  title: string
  agent: string
  model?: string
  /** Per-call working directory override (e.g. an isolation worktree). */
  directory?: string
  /**
   * Phase the agent belongs to. Runners may fold it into the child session's
   * title so the session is identifiable in OpenCode's session list and in the
   * one native surface that shows a child title (see sdk.ts).
   */
  phase?: string
}

export interface RunChildSessionInput {
  sessionID: string
  agent: string
  model?: string
  prompt: string
  /**
   * Extra system prompt for this call, sent as `system` on
   * POST /session/{id}/message. Used to tell the subagent that its final text
   * is consumed programmatically as a return value.
   */
  system?: string
  noReply?: boolean
  abort?: AbortSignal
  /** Per-call working directory override (e.g. an isolation worktree). */
  directory?: string
  /**
   * OpenCode model variant id for this call, sent as `variant` on
   * POST /session/{id}/message. The server merges `model.variants[variant]`
   * into the provider options, which is how reasoning effort is expressed.
   */
  variant?: string
  /**
   * JSON Schema for OpenCode's native structured output, sent as `format` on
   * POST /session/{id}/message. OpenCode responds by injecting a forced
   * StructuredOutput tool call, but it does NOT validate the tool arguments
   * against this schema - callers must still validate what comes back.
   */
  schema?: JsonSchemaLike
}

export interface RunChildSessionResult {
  text: string
  /**
   * The value OpenCode captured from its native StructuredOutput tool when
   * `schema` was sent, already parsed. Undefined when no schema was sent or
   * the model never called the tool. NOT schema-validated by OpenCode.
   */
  structured?: unknown
  error?: string
  /**
   * OpenCode's error class name (e.g. "APIError", "StructuredOutputError").
   * Callers branch on it to tell a provider rejection apart from a model miss.
   */
  errorName?: string
  sessionID: string
  finish?: string
  tokens?: {
    input?: number
    output?: number
  }
}

export interface SessionRunner {
  createChildSession(input: CreateChildSessionInput): Promise<{ sessionID: string }>
  runChildSession(input: RunChildSessionInput): Promise<RunChildSessionResult>
  deleteSession(sessionID: string): Promise<void>
  /**
   * The model currently in use in the parent session — i.e. the one the user
   * picked in the TUI — as "provider/model-id", or undefined if it cannot be
   * determined. Child sessions default to this so a workflow runs on the
   * user's selected model rather than the config-level default.
   */
  resolveParentModel?(): Promise<string | undefined>
  /**
   * Variant ids the given "provider/model-id" exposes (e.g. ["low", "high",
   * "max"]), or undefined when the catalogue cannot be read - callers then
   * send the requested variant unchecked rather than failing the run.
   */
  listModelVariants?(model: string): Promise<string[] | undefined>
  /**
   * Agent names this OpenCode instance knows, or undefined when the registry
   * cannot be read. Used to reject a typo'd agent() `agentType` up front
   * instead of letting it surface as an indistinguishable null agent result.
   */
  listAgents?(): Promise<string[] | undefined>
}

export type SessionClient = OpencodeClient

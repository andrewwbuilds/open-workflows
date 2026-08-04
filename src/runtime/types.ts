import type { OpencodeClient } from "@opencode-ai/sdk"

export interface CreateChildSessionInput {
  title: string
  agent: string
  model?: string
  /** Per-call working directory override (e.g. an isolation worktree). */
  directory?: string
}

export interface RunChildSessionInput {
  sessionID: string
  agent: string
  model?: string
  prompt: string
  noReply?: boolean
  abort?: AbortSignal
  /** Per-call working directory override (e.g. an isolation worktree). */
  directory?: string
}

export interface RunChildSessionResult {
  text: string
  error?: string
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
}

export type SessionClient = OpencodeClient

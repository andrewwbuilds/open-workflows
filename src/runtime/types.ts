import type { OpencodeClient } from "@opencode-ai/sdk"

export interface CreateChildSessionInput {
  title: string
  agent: string
  model?: string
}

export interface RunChildSessionInput {
  sessionID: string
  agent: string
  model?: string
  prompt: string
  noReply?: boolean
  abort?: AbortSignal
}

export interface RunChildSessionResult {
  text: string
  error?: string
  sessionID: string
  finish?: string
}

export interface SessionRunner {
  createChildSession(input: CreateChildSessionInput): Promise<{ sessionID: string }>
  runChildSession(input: RunChildSessionInput): Promise<RunChildSessionResult>
  deleteSession(sessionID: string): Promise<void>
}

export type SessionClient = OpencodeClient

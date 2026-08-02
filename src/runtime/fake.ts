import type { CreateChildSessionInput, RunChildSessionInput, RunChildSessionResult, SessionRunner } from "./types.js"

export interface FakeRunnerOptions {
  responses?: Map<string, string>
  defaultResponse?: string
  delayMs?: number
}

export function createFakeRunner(options: FakeRunnerOptions = {}): SessionRunner & {
  created: Array<CreateChildSessionInput & { sessionID: string }>
  runs: Array<RunChildSessionInput & RunChildSessionResult>
} {
  const created: Array<CreateChildSessionInput & { sessionID: string }> = []
  const runs: Array<RunChildSessionInput & RunChildSessionResult> = []
  let counter = 0

  return {
    created,
    runs,
    async createChildSession(input) {
      counter += 1
      const sessionID = `fake-${counter}`
      created.push({ ...input, sessionID })
      return { sessionID }
    },
    async runChildSession(input) {
      if (options.delayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.delayMs))
      }
      const text = options.responses?.get(input.sessionID) ?? options.defaultResponse ?? ""
      const result: RunChildSessionResult = { text, sessionID: input.sessionID }
      runs.push({ ...input, ...result })
      return result
    },
    async deleteSession() {
      // no-op
    },
  }
}

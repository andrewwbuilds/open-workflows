import type { CreateChildSessionInput, RunChildSessionInput, RunChildSessionResult, SessionRunner } from "./types.js"

export interface FakeRunnerOptions {
  responses?: Map<string, string>
  defaultResponse?: string
  delayMs?: number
  /** "provider/model-id" -> variant ids; omit to leave the catalogue unknown. */
  variants?: Map<string, string[]>
  /** Agent names the registry reports; omit to leave the registry unknown. */
  agents?: string[]
  /**
   * Per-session value to return as OpenCode's native structured output, as if
   * the model had called the StructuredOutput tool. Deliberately unvalidated,
   * mirroring OpenCode, which never checks it against the schema.
   */
  structured?: Map<string, unknown>
  /** Per-session error to report, with OpenCode's error class name. */
  errors?: Map<string, { message: string; name?: string }>
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
      const failure = options.errors?.get(input.sessionID)
      const result: RunChildSessionResult = {
        text,
        sessionID: input.sessionID,
        structured: options.structured?.get(input.sessionID),
        error: failure?.message,
        errorName: failure?.name,
      }
      runs.push({ ...input, ...result })
      return result
    },
    async deleteSession() {
      // no-op
    },
    async listModelVariants(model) {
      return options.variants?.get(model)
    },
    async listAgents() {
      return options.agents
    },
  }
}

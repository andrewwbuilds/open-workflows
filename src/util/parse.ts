import type { PlannerOutput, ReviewerOutput, WorkerOutput } from "../types.js"

const CODE_FENCE_RE = /^```(?:json|JSON)?\s*\n?/

function extractJsonCandidates(text: string): string[] {
  const candidates: string[] = []

  const fenceMatch = text.match(/```(?:json|JSON)?\s*\n([\s\S]*?)\n```/g)
  if (fenceMatch) {
    for (const block of fenceMatch) {
      const inner = block.replace(CODE_FENCE_RE, "").replace(/```\s*$/, "")
      if (inner.trim().length > 0) candidates.push(inner.trim())
    }
  }

  let depth = 0
  let start = -1
  let inString = false
  let escape = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (inString) {
      if (escape) {
        escape = false
      } else if (ch === "\\") {
        escape = true
      } else if (ch === "\"") {
        inString = false
      }
      continue
    }
    if (ch === "\"") {
      inString = true
      continue
    }
    if (ch === "{") {
      if (depth === 0) start = i
      depth += 1
      continue
    }
    if (ch === "}") {
      depth -= 1
      if (depth === 0 && start >= 0) {
        candidates.push(text.slice(start, i + 1))
        start = -1
      }
    }
  }
  return candidates
}

function tryParse<T>(value: string): T | undefined {
  try {
    return JSON.parse(value) as T
  } catch {
    return undefined
  }
}

export function parseStructuredOutput<T>(
  text: string,
  validate: (value: unknown) => value is T,
): T | undefined {
  const trimmed = text.trim()
  if (trimmed.length === 0) return undefined

  const direct = tryParse<T>(trimmed)
  if (direct && validate(direct)) return direct

  for (const candidate of extractJsonCandidates(trimmed)) {
    const parsed = tryParse<unknown>(candidate)
    if (parsed && validate(parsed)) return parsed
  }
  return undefined
}

export function isPlannerOutput(value: unknown): value is PlannerOutput {
  if (!value || typeof value !== "object") return false
  const candidate = value as Record<string, unknown>
  if (!Array.isArray(candidate.plan)) return false
  if (typeof candidate.rationale !== "string") return false
  return true
}

export function isReviewerOutput(value: unknown): value is ReviewerOutput {
  if (!value || typeof value !== "object") return false
  const candidate = value as Record<string, unknown>
  if (typeof candidate.summary !== "string") return false
  if (typeof candidate.status !== "string") return false
  if (!Array.isArray(candidate.followUps)) return false
  if (!Array.isArray(candidate.criteriaMet)) return false
  if (!Array.isArray(candidate.criteriaMissed)) return false
  return ["pass", "needs-attention", "blocked"].includes(candidate.status as string)
}

export function isWorkerOutput(value: unknown): value is WorkerOutput {
  if (!value || typeof value !== "object") return false
  const candidate = value as Record<string, unknown>
  if (typeof candidate.summary !== "string") return false
  if (typeof candidate.status !== "string") return false
  return ["completed", "needs-attention", "blocked"].includes(candidate.status as string)
}

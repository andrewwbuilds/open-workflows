export interface WorkflowPhaseMeta {
  title: string
  detail?: string
  model?: string
}

export interface WorkflowMeta {
  name: string
  description: string
  whenToUse?: string
  phases?: WorkflowPhaseMeta[]
}

export interface ParsedWorkflowScript {
  meta: WorkflowMeta
  body: string
}

const META_PATTERN = /^export\s+const\s+meta\s*=/

/**
 * Split a workflow script into its `export const meta = {...}` literal and the
 * executable body. The meta object must be a pure literal (no identifiers,
 * calls, or spreads) so it can be evaluated without running the script.
 */
export function parseWorkflowScript(script: string): ParsedWorkflowScript {
  const match = findMetaStatement(script)
  if (!match) {
    throw new Error(
      "Workflow script must begin with `export const meta = { name, description, ... }`.",
    )
  }
  const literalStart = script.indexOf("{", match.index + match.length)
  if (literalStart < 0) {
    throw new Error("Workflow meta must be an object literal: `export const meta = {...}`.")
  }
  const literalEnd = findBalancedEnd(script, literalStart)
  const literal = script.slice(literalStart, literalEnd + 1)
  assertPureLiteral(literal)

  let meta: unknown
  try {
    meta = new Function(`"use strict"; return (${literal})`)()
  } catch (error) {
    throw new Error(`Workflow meta is not a valid object literal: ${message(error)}`)
  }
  const validated = validateMeta(meta)

  let bodyEnd = literalEnd + 1
  if (script[bodyEnd] === ";") bodyEnd += 1
  const body = script.slice(0, match.index) + script.slice(bodyEnd)
  return { meta: validated, body }
}

/**
 * Locate `export const meta =` at code level, skipping occurrences inside
 * comments and string literals (e.g. a doc comment quoting the convention).
 */
function findMetaStatement(script: string): { index: number; length: number } | undefined {
  let index = 0
  while (index < script.length) {
    const char = script[index]
    if (char === '"' || char === "'" || char === "`") {
      try {
        index = skipString(script, index)
      } catch {
        index += 1
      }
      continue
    }
    if (char === "/" && script[index + 1] === "/") {
      index = skipLineComment(script, index)
      continue
    }
    if (char === "/" && script[index + 1] === "*") {
      try {
        index = skipBlockComment(script, index)
      } catch {
        index += 2
      }
      continue
    }
    if (char === "e") {
      const match = META_PATTERN.exec(script.slice(index))
      if (match) {
        return { index, length: match[0].length }
      }
    }
    index += 1
  }
  return undefined
}

function validateMeta(meta: unknown): WorkflowMeta {
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) {
    throw new Error("Workflow meta must be an object with `name` and `description`.")
  }
  const record = meta as Record<string, unknown>
  if (typeof record.name !== "string" || record.name.trim() === "") {
    throw new Error("Workflow meta requires a non-empty string `name`.")
  }
  if (typeof record.description !== "string" || record.description.trim() === "") {
    throw new Error("Workflow meta requires a non-empty string `description`.")
  }
  const phases: WorkflowPhaseMeta[] = []
  if (record.phases !== undefined) {
    if (!Array.isArray(record.phases)) {
      throw new Error("Workflow meta `phases` must be an array of { title, detail? }.")
    }
    for (const phase of record.phases) {
      if (typeof phase !== "object" || phase === null) {
        throw new Error("Each meta phase must be an object with a `title`.")
      }
      const entry = phase as Record<string, unknown>
      if (typeof entry.title !== "string" || entry.title.trim() === "") {
        throw new Error("Each meta phase requires a non-empty string `title`.")
      }
      phases.push({
        title: entry.title,
        detail: typeof entry.detail === "string" ? entry.detail : undefined,
        model: typeof entry.model === "string" ? entry.model : undefined,
      })
    }
  }
  return {
    name: record.name,
    description: record.description,
    whenToUse: typeof record.whenToUse === "string" ? record.whenToUse : undefined,
    phases: phases.length > 0 ? phases : undefined,
  }
}

/**
 * Reject meta literals containing computation. Identifiers are only allowed as
 * object keys, `true`/`false`/`null`, or inside string literals.
 */
function assertPureLiteral(literal: string): void {
  const stripped = stripStringsAndComments(literal)
  if (/[(`]|\.\.\./.test(stripped)) {
    throw new Error(
      "Workflow meta must be a pure literal - no function calls, template strings, or spreads.",
    )
  }
  const identifiers = stripped.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? []
  for (const identifier of identifiers) {
    if (identifier === "true" || identifier === "false" || identifier === "null") continue
    if (new RegExp(`${escapeRegExp(identifier)}\\s*:`).test(stripped)) continue
    throw new Error(
      `Workflow meta must be a pure literal - unexpected identifier "${identifier}".`,
    )
  }
}

function findBalancedEnd(script: string, start: number): number {
  let depth = 0
  let index = start
  while (index < script.length) {
    const char = script[index]
    if (char === '"' || char === "'" || char === "`") {
      index = skipString(script, index)
      continue
    }
    if (char === "/" && script[index + 1] === "/") {
      index = skipLineComment(script, index)
      continue
    }
    if (char === "/" && script[index + 1] === "*") {
      index = skipBlockComment(script, index)
      continue
    }
    if (char === "{" || char === "[") depth += 1
    if (char === "}" || char === "]") {
      depth -= 1
      if (depth === 0) return index
    }
    index += 1
  }
  throw new Error("Workflow meta object literal is not balanced (missing closing brace).")
}

function skipString(script: string, start: number): number {
  const quote = script[start]
  let index = start + 1
  while (index < script.length) {
    if (script[index] === "\\") {
      index += 2
      continue
    }
    if (script[index] === quote) return index + 1
    index += 1
  }
  throw new Error("Workflow meta contains an unterminated string literal.")
}

function skipLineComment(script: string, start: number): number {
  const end = script.indexOf("\n", start)
  return end < 0 ? script.length : end + 1
}

function skipBlockComment(script: string, start: number): number {
  const end = script.indexOf("*/", start + 2)
  if (end < 0) throw new Error("Workflow meta contains an unterminated block comment.")
  return end + 2
}

function stripStringsAndComments(literal: string): string {
  let out = ""
  let index = 0
  while (index < literal.length) {
    const char = literal[index]
    if (char === '"' || char === "'" || char === "`") {
      const end = skipString(literal, index)
      out += char === "`" ? "`" : '""'
      index = end
      continue
    }
    if (char === "/" && literal[index + 1] === "/") {
      index = skipLineComment(literal, index)
      continue
    }
    if (char === "/" && literal[index + 1] === "*") {
      index = skipBlockComment(literal, index)
      continue
    }
    out += char
    index += 1
  }
  return out
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

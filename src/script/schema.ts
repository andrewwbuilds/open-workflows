export interface JsonSchemaLike {
  type?: string
  properties?: Record<string, JsonSchemaLike>
  required?: string[]
  items?: JsonSchemaLike
  enum?: unknown[]
  [key: string]: unknown
}

export function buildSchemaInstruction(schema: JsonSchemaLike): string {
  return [
    "",
    "IMPORTANT: Your entire final response MUST be a single JSON value matching this JSON Schema.",
    "No prose, no markdown fences, no explanation - JSON only:",
    JSON.stringify(schema, null, 2),
  ].join("\n")
}

export function buildSchemaRetryPrompt(error: string, schema: JsonSchemaLike): string {
  return [
    `Your previous response was rejected: ${error}`,
    "Respond again with ONLY a JSON value matching this JSON Schema (no prose, no fences):",
    JSON.stringify(schema, null, 2),
  ].join("\n")
}

export interface SchemaParseResult {
  ok: boolean
  value?: unknown
  error?: string
}

export function parseWithSchema(text: string, schema: JsonSchemaLike): SchemaParseResult {
  const json = extractJson(text)
  if (json === undefined) {
    return { ok: false, error: "response contained no parseable JSON" }
  }
  const problem = validateAgainstSchema(json, schema, "$")
  if (problem) {
    return { ok: false, error: problem }
  }
  return { ok: true, value: json }
}

/**
 * Pull the first JSON value out of a model response, tolerating markdown
 * fences and surrounding prose.
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim()
  const candidates: string[] = []
  const fence = /```(?:json)?\s*\n?([\s\S]*?)```/g
  let match: RegExpExecArray | null
  while ((match = fence.exec(trimmed)) !== null) {
    if (match[1]) candidates.push(match[1].trim())
  }
  candidates.push(trimmed)
  const firstBrace = trimmed.search(/[{[]/)
  if (firstBrace > 0) {
    candidates.push(trimmed.slice(firstBrace))
  }
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate)
    } catch {
      const balanced = truncateToBalanced(candidate)
      if (balanced) {
        try {
          return JSON.parse(balanced)
        } catch {
          // try next candidate
        }
      }
    }
  }
  return undefined
}

function truncateToBalanced(candidate: string): string | undefined {
  const start = candidate.search(/[{[]/)
  if (start < 0) return undefined
  let depth = 0
  let inString = false
  for (let index = start; index < candidate.length; index += 1) {
    const char = candidate[index]
    if (inString) {
      if (char === "\\") index += 1
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === "{" || char === "[") depth += 1
    else if (char === "}" || char === "]") {
      depth -= 1
      if (depth === 0) return candidate.slice(start, index + 1)
    }
  }
  return undefined
}

/**
 * Minimal JSON Schema validation covering type, properties, required, items,
 * and enum - the subset workflow scripts actually use. Returns an error
 * message or undefined when valid.
 */
export function validateAgainstSchema(
  value: unknown,
  schema: JsonSchemaLike,
  path: string,
): string | undefined {
  if (schema.enum) {
    const matches = schema.enum.some((entry) => JSON.stringify(entry) === JSON.stringify(value))
    if (!matches) return `${path} must be one of ${JSON.stringify(schema.enum)}`
    return undefined
  }
  if (schema.type) {
    const actual = jsonType(value)
    const expected = Array.isArray(schema.type) ? schema.type : [schema.type]
    const matched = expected.some(
      (type) =>
        type === actual
        || (type === "integer" && actual === "number" && Number.isInteger(value)),
    )
    if (!matched) {
      const detail = actual === "number" && !Number.isInteger(value as number) ? `${actual} ${String(value)}` : actual
      return `${path} must be ${expected.join(" or ")}, got ${detail}`
    }
  }
  if (schema.type === "object" || schema.properties || schema.required) {
    if (jsonType(value) !== "object") {
      return `${path} must be an object`
    }
    const record = value as Record<string, unknown>
    for (const key of schema.required ?? []) {
      if (!(key in record)) return `${path}.${key} is required`
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (key in record) {
        const problem = validateAgainstSchema(record[key], child, `${path}.${key}`)
        if (problem) return problem
      }
    }
  }
  if (schema.type === "array" || schema.items) {
    if (!Array.isArray(value)) return `${path} must be an array`
    if (schema.items) {
      for (let index = 0; index < value.length; index += 1) {
        const problem = validateAgainstSchema(value[index], schema.items, `${path}[${index}]`)
        if (problem) return problem
      }
    }
  }
  return undefined
}

function jsonType(value: unknown): string {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  return typeof value
}

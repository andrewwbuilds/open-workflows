export interface JsonSchemaLike {
  type?: string | string[]
  properties?: Record<string, JsonSchemaLike>
  required?: string[]
  items?: JsonSchemaLike
  enum?: unknown[]
  const?: unknown
  oneOf?: JsonSchemaLike[]
  anyOf?: JsonSchemaLike[]
  allOf?: JsonSchemaLike[]
  pattern?: string
  minLength?: number
  maxLength?: number
  minimum?: number
  maximum?: number
  exclusiveMinimum?: number
  exclusiveMaximum?: number
  minItems?: number
  maxItems?: number
  additionalProperties?: boolean | JsonSchemaLike
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
 * Minimal JSON Schema validation covering the subset workflow scripts actually
 * use: type (including type arrays like ["string","null"]), properties,
 * required, items, enum, const, oneOf/anyOf/allOf, pattern,
 * minLength/maxLength, minimum/maximum/exclusiveMinimum/exclusiveMaximum,
 * minItems/maxItems, and additionalProperties. Returns an error message or
 * undefined when valid.
 */
export function validateAgainstSchema(
  value: unknown,
  schema: JsonSchemaLike,
  path: string,
): string | undefined {
  if (Object.hasOwn(schema, "const")) {
    if (!jsonEquals(value, schema.const)) {
      return `${path} must equal ${JSON.stringify(schema.const)}`
    }
    return undefined
  }
  if (schema.enum) {
    const matches = schema.enum.some((entry) => jsonEquals(entry, value))
    if (!matches) return `${path} must be one of ${JSON.stringify(schema.enum)}`
    return undefined
  }
  if (schema.allOf) {
    for (const sub of schema.allOf) {
      const problem = validateAgainstSchema(value, sub, path)
      if (problem) return problem
    }
  }
  if (schema.anyOf) {
    const errors = schema.anyOf.map((sub) => validateAgainstSchema(value, sub, path))
    if (!errors.some((error) => error === undefined)) {
      return `${path} must match at least one schema in anyOf (closest: ${errors[0]})`
    }
  }
  if (schema.oneOf) {
    const matched = schema.oneOf.filter(
      (sub) => validateAgainstSchema(value, sub, path) === undefined,
    ).length
    if (matched !== 1) {
      return `${path} must match exactly one schema in oneOf, matched ${matched}`
    }
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
  const wantsObject = schema.type === "object"
    || schema.properties !== undefined
    || schema.required !== undefined
    || schema.additionalProperties !== undefined
  if (wantsObject) {
    if (jsonType(value) !== "object") {
      // A type array like ["object","null"] already vetted non-object values;
      // only reject here when the schema declares no other acceptable type.
      if (!Array.isArray(schema.type)) return `${path} must be an object`
    } else {
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
      if (schema.additionalProperties !== undefined && schema.additionalProperties !== true) {
        const known = new Set(Object.keys(schema.properties ?? {}))
        for (const key of Object.keys(record)) {
          if (known.has(key)) continue
          if (schema.additionalProperties === false) {
            return `${path}.${key} is not an allowed property`
          }
          const problem = validateAgainstSchema(record[key], schema.additionalProperties, `${path}.${key}`)
          if (problem) return problem
        }
      }
    }
  }
  const wantsArray = schema.type === "array"
    || schema.items !== undefined
    || schema.minItems !== undefined
    || schema.maxItems !== undefined
  if (wantsArray) {
    if (!Array.isArray(value)) {
      if (!Array.isArray(schema.type)) return `${path} must be an array`
    } else {
      if (schema.minItems !== undefined && value.length < schema.minItems) {
        return `${path} must have at least ${schema.minItems} items, got ${value.length}`
      }
      if (schema.maxItems !== undefined && value.length > schema.maxItems) {
        return `${path} must have at most ${schema.maxItems} items, got ${value.length}`
      }
      if (schema.items) {
        for (let index = 0; index < value.length; index += 1) {
          const problem = validateAgainstSchema(value[index], schema.items, `${path}[${index}]`)
          if (problem) return problem
        }
      }
    }
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      return `${path} must be at least ${schema.minLength} characters, got ${value.length}`
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      return `${path} must be at most ${schema.maxLength} characters, got ${value.length}`
    }
    if (schema.pattern !== undefined) {
      let regex: RegExp
      try {
        regex = new RegExp(schema.pattern)
      } catch {
        return `${path} has an invalid pattern in its schema: ${schema.pattern}`
      }
      if (!regex.test(value)) {
        return `${path} must match pattern ${schema.pattern}`
      }
    }
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      return `${path} must be >= ${schema.minimum}, got ${value}`
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      return `${path} must be <= ${schema.maximum}, got ${value}`
    }
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) {
      return `${path} must be > ${schema.exclusiveMinimum}, got ${value}`
    }
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) {
      return `${path} must be < ${schema.exclusiveMaximum}, got ${value}`
    }
  }
  return undefined
}

/** Deep equality on JSON values, insensitive to object key order. */
function jsonEquals(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== typeof b) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((entry, index) => jsonEquals(entry, b[index]))
  }
  if (typeof a === "object" && typeof b === "object" && a !== null && b !== null) {
    const aKeys = Object.keys(a)
    const bKeys = Object.keys(b)
    if (aKeys.length !== bKeys.length) return false
    return aKeys.every((key) =>
      Object.hasOwn(b, key)
      && jsonEquals((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
    )
  }
  return false
}

function jsonType(value: unknown): string {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  return typeof value
}

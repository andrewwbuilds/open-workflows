export interface JsonSchemaLike {
  type?: string | string[]
  properties?: Record<string, JsonSchemaLike>
  required?: string[]
  items?: JsonSchemaLike
  prefixItems?: JsonSchemaLike[]
  contains?: JsonSchemaLike
  minContains?: number
  maxContains?: number
  patternProperties?: Record<string, JsonSchemaLike>
  propertyNames?: JsonSchemaLike
  dependentRequired?: Record<string, string[]>
  dependentSchemas?: Record<string, JsonSchemaLike>
  enum?: unknown[]
  const?: unknown
  oneOf?: JsonSchemaLike[]
  anyOf?: JsonSchemaLike[]
  allOf?: JsonSchemaLike[]
  not?: JsonSchemaLike
  if?: JsonSchemaLike
  then?: JsonSchemaLike
  else?: JsonSchemaLike
  pattern?: string
  minLength?: number
  maxLength?: number
  minimum?: number
  maximum?: number
  exclusiveMinimum?: number
  exclusiveMaximum?: number
  multipleOf?: number
  minItems?: number
  maxItems?: number
  uniqueItems?: boolean
  minProperties?: number
  maxProperties?: number
  additionalProperties?: boolean | JsonSchemaLike
  [key: string]: unknown
}

/**
 * Keywords this validator cannot evaluate. Silently ignoring one would make a
 * constrained schema validate as if the constraint were absent, so agent()
 * rejects a schema containing any of them instead (see collectUnsupportedKeywords).
 *
 * `format` is NOT here: JSON Schema defines it as an annotation rather than an
 * assertion by default, so ignoring it is spec-conformant.
 */
const UNSUPPORTED_KEYWORDS = [
  "$ref",
  "$dynamicRef",
  "$defs",
  "definitions",
  "unevaluatedProperties",
  "unevaluatedItems",
] as const

const SUBSCHEMA_KEYS = ["items", "contains", "propertyNames", "not", "if", "then", "else", "additionalProperties"] as const
const SUBSCHEMA_LIST_KEYS = ["oneOf", "anyOf", "allOf", "prefixItems"] as const
const SUBSCHEMA_MAP_KEYS = ["properties", "patternProperties", "dependentSchemas"] as const

/**
 * Every unsupported keyword reachable in `schema`, as dotted paths, sorted and
 * de-duplicated. Empty means the schema is fully within the validator's reach.
 */
export function collectUnsupportedKeywords(schema: JsonSchemaLike): string[] {
  const found = new Set<string>()
  const seen = new Set<JsonSchemaLike>()
  const walk = (node: unknown, path: string): void => {
    if (typeof node !== "object" || node === null || Array.isArray(node)) return
    const record = node as JsonSchemaLike
    if (seen.has(record)) return
    seen.add(record)
    for (const keyword of UNSUPPORTED_KEYWORDS) {
      if (Object.hasOwn(record, keyword)) found.add(`${path}${keyword}`)
    }
    for (const key of SUBSCHEMA_KEYS) {
      walk(record[key], `${path}${key}.`)
    }
    for (const key of SUBSCHEMA_LIST_KEYS) {
      const list = record[key]
      if (!Array.isArray(list)) continue
      list.forEach((entry, index) => walk(entry, `${path}${key}[${index}].`))
    }
    for (const key of SUBSCHEMA_MAP_KEYS) {
      const map = record[key]
      if (typeof map !== "object" || map === null) continue
      for (const [name, entry] of Object.entries(map)) {
        walk(entry, `${path}${key}.${name}.`)
      }
    }
  }
  walk(schema, "")
  return [...found].sort()
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
  return validateValue(json, schema)
}

/**
 * Validate an ALREADY-PARSED value, which is what OpenCode's native structured
 * output hands back. This is not defense in depth - it is the only validation
 * in the chain: OpenCode builds the StructuredOutput tool's input schema with
 * no validator attached, so it accepts whatever the model passes (a wrong type
 * and an extra property under `additionalProperties: false` both go through).
 */
export function validateValue(value: unknown, schema: JsonSchemaLike): SchemaParseResult {
  const problem = validateAgainstSchema(value, schema, "$")
  if (problem) {
    return { ok: false, error: problem }
  }
  return { ok: true, value }
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
 * JSON Schema validation covering everything workflow scripts can express:
 * type (including type arrays like ["string","null"]), properties, required,
 * additionalProperties, patternProperties, propertyNames,
 * minProperties/maxProperties, dependentRequired/dependentSchemas, items,
 * prefixItems, contains/minContains/maxContains, minItems/maxItems,
 * uniqueItems, enum, const, oneOf/anyOf/allOf/not, if/then/else, pattern,
 * minLength/maxLength, minimum/maximum/exclusiveMinimum/exclusiveMaximum, and
 * multipleOf. Returns an error message or undefined when valid.
 *
 * `const` and `enum` deliberately short-circuit: they pin the value exactly,
 * so no other keyword can add information. Everything the validator cannot
 * evaluate is rejected up front by collectUnsupportedKeywords rather than
 * being ignored here.
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
  if (schema.not && validateAgainstSchema(value, schema.not, path) === undefined) {
    return `${path} must not match the "not" schema`
  }
  if (schema.if) {
    const branch = validateAgainstSchema(value, schema.if, path) === undefined
      ? schema.then
      : schema.else
    if (branch) {
      const problem = validateAgainstSchema(value, branch, path)
      if (problem) return problem
    }
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
    || schema.patternProperties !== undefined
    || schema.propertyNames !== undefined
    || schema.dependentRequired !== undefined
    || schema.dependentSchemas !== undefined
    || schema.minProperties !== undefined
    || schema.maxProperties !== undefined
  if (wantsObject) {
    if (jsonType(value) !== "object") {
      // A type array like ["object","null"] already vetted non-object values;
      // only reject here when the schema declares no other acceptable type.
      if (!Array.isArray(schema.type)) return `${path} must be an object`
    } else {
      const problem = validateObject(value as Record<string, unknown>, schema, path)
      if (problem) return problem
    }
  }
  const wantsArray = schema.type === "array"
    || schema.items !== undefined
    || schema.prefixItems !== undefined
    || schema.contains !== undefined
    || schema.minItems !== undefined
    || schema.maxItems !== undefined
    || schema.uniqueItems !== undefined
  if (wantsArray) {
    if (!Array.isArray(value)) {
      if (!Array.isArray(schema.type)) return `${path} must be an array`
    } else {
      const problem = validateArray(value, schema, path)
      if (problem) return problem
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
    if (schema.multipleOf !== undefined && schema.multipleOf > 0) {
      // Scale to integers before the modulo: 0.3 % 0.1 is 0.0999... in binary
      // floating point, which would reject a schema-conformant value.
      const quotient = value / schema.multipleOf
      if (Math.abs(quotient - Math.round(quotient)) > 1e-9) {
        return `${path} must be a multiple of ${schema.multipleOf}, got ${value}`
      }
    }
  }
  return undefined
}

function validateObject(
  record: Record<string, unknown>,
  schema: JsonSchemaLike,
  path: string,
): string | undefined {
  const keys = Object.keys(record)
  if (schema.minProperties !== undefined && keys.length < schema.minProperties) {
    return `${path} must have at least ${schema.minProperties} properties, got ${keys.length}`
  }
  if (schema.maxProperties !== undefined && keys.length > schema.maxProperties) {
    return `${path} must have at most ${schema.maxProperties} properties, got ${keys.length}`
  }
  for (const key of schema.required ?? []) {
    if (!(key in record)) return `${path}.${key} is required`
  }
  for (const [key, child] of Object.entries(schema.properties ?? {})) {
    if (key in record) {
      const problem = validateAgainstSchema(record[key], child, `${path}.${key}`)
      if (problem) return problem
    }
  }
  const patterns = Object.entries(schema.patternProperties ?? {})
  for (const [pattern, child] of patterns) {
    const regex = compilePattern(pattern)
    if (!regex) return `${path} has an invalid patternProperties pattern in its schema: ${pattern}`
    for (const key of keys) {
      if (!regex.test(key)) continue
      const problem = validateAgainstSchema(record[key], child, `${path}.${key}`)
      if (problem) return problem
    }
  }
  if (schema.propertyNames) {
    for (const key of keys) {
      const problem = validateAgainstSchema(key, schema.propertyNames, `${path} property name "${key}"`)
      if (problem) return problem
    }
  }
  for (const [key, dependents] of Object.entries(schema.dependentRequired ?? {})) {
    if (!(key in record)) continue
    for (const dependent of dependents) {
      if (!(dependent in record)) return `${path}.${dependent} is required when ${key} is present`
    }
  }
  for (const [key, child] of Object.entries(schema.dependentSchemas ?? {})) {
    if (!(key in record)) continue
    const problem = validateAgainstSchema(record, child, path)
    if (problem) return problem
  }
  if (schema.additionalProperties !== undefined && schema.additionalProperties !== true) {
    const known = new Set(Object.keys(schema.properties ?? {}))
    const patternRegexes = patterns
      .map(([pattern]) => compilePattern(pattern))
      .filter((regex): regex is RegExp => regex !== undefined)
    for (const key of keys) {
      if (known.has(key)) continue
      if (patternRegexes.some((regex) => regex.test(key))) continue
      if (schema.additionalProperties === false) {
        return `${path}.${key} is not an allowed property`
      }
      const problem = validateAgainstSchema(record[key], schema.additionalProperties, `${path}.${key}`)
      if (problem) return problem
    }
  }
  return undefined
}

function validateArray(
  value: unknown[],
  schema: JsonSchemaLike,
  path: string,
): string | undefined {
  if (schema.minItems !== undefined && value.length < schema.minItems) {
    return `${path} must have at least ${schema.minItems} items, got ${value.length}`
  }
  if (schema.maxItems !== undefined && value.length > schema.maxItems) {
    return `${path} must have at most ${schema.maxItems} items, got ${value.length}`
  }
  const prefix = schema.prefixItems ?? []
  for (let index = 0; index < prefix.length && index < value.length; index += 1) {
    const problem = validateAgainstSchema(value[index], prefix[index] as JsonSchemaLike, `${path}[${index}]`)
    if (problem) return problem
  }
  if (schema.items) {
    // With prefixItems present, `items` constrains only the tail, per 2020-12.
    for (let index = prefix.length; index < value.length; index += 1) {
      const problem = validateAgainstSchema(value[index], schema.items, `${path}[${index}]`)
      if (problem) return problem
    }
  }
  if (schema.contains) {
    const matches = value.filter(
      (entry, index) => validateAgainstSchema(entry, schema.contains as JsonSchemaLike, `${path}[${index}]`) === undefined,
    ).length
    const min = schema.minContains ?? 1
    if (matches < min) {
      return `${path} must contain at least ${min} matching item(s), matched ${matches}`
    }
    if (schema.maxContains !== undefined && matches > schema.maxContains) {
      return `${path} must contain at most ${schema.maxContains} matching item(s), matched ${matches}`
    }
  }
  if (schema.uniqueItems === true) {
    for (let index = 0; index < value.length; index += 1) {
      for (let other = index + 1; other < value.length; other += 1) {
        if (jsonEquals(value[index], value[other])) {
          return `${path} must have unique items, but [${index}] and [${other}] are equal`
        }
      }
    }
  }
  return undefined
}

function compilePattern(pattern: string): RegExp | undefined {
  try {
    return new RegExp(pattern)
  } catch {
    return undefined
  }
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

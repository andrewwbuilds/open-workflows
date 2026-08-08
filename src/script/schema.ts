export interface JsonSchemaLike {
  $ref?: string
  $defs?: Record<string, JsonSchemaLike>
  definitions?: Record<string, JsonSchemaLike>
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
  "$dynamicRef",
  "unevaluatedProperties",
  "unevaluatedItems",
] as const

const SUBSCHEMA_KEYS = ["items", "contains", "propertyNames", "not", "if", "then", "else", "additionalProperties"] as const
const SUBSCHEMA_LIST_KEYS = ["oneOf", "anyOf", "allOf", "prefixItems"] as const
const SUBSCHEMA_MAP_KEYS = ["properties", "patternProperties", "dependentSchemas", "$defs", "definitions"] as const

/**
 * Every unsupported keyword reachable in `schema`, as dotted paths, sorted and
 * de-duplicated. Empty means the schema is fully within the validator's reach.
 */
export function collectUnsupportedKeywords(schema: JsonSchemaLike): string[] {
  const found = new Set<string>()
  forEachSubschema(schema, (node, path) => {
    for (const keyword of UNSUPPORTED_KEYWORDS) {
      if (Object.hasOwn(node, keyword)) found.add(`${path}${keyword}`)
    }
  })
  return [...found].sort()
}

/**
 * Every $ref in `schema` the validator cannot follow: an external document, an
 * $anchor, a pointer that resolves to nothing, or a ref chain that only ever
 * points at more refs. Reported at agent() time so a bad ref fails before a
 * session is spawned instead of surfacing later as a schema-validation miss
 * that burns the call's schema retries.
 *
 * A STRUCTURAL cycle - one that goes through a value-consuming keyword, like
 * `{ $defs: { Node: { properties: { next: { $ref: "#/$defs/Node" } } } } }` -
 * is legal and deliberately not reported: validation terminates because JSON
 * values are finite trees. Only ref-to-ref chains hang, and MAX_VALIDATION_DEPTH
 * backstops the rest.
 */
export function collectRefProblems(schema: JsonSchemaLike): string[] {
  const problems = new Set<string>()
  forEachSubschema(schema, (node, path) => {
    if (typeof node.$ref !== "string") return
    const label = `${path}$ref`
    const chain = new Set<string>()
    let current = node.$ref
    for (;;) {
      if (chain.has(current)) {
        problems.add(`${label}: circular $ref chain ${[...chain, current].join(" -> ")}`)
        return
      }
      chain.add(current)
      const resolved = resolveRef(current, schema)
      if (!resolved.ok) {
        problems.add(`${label}: ${resolved.error}`)
        return
      }
      const next = resolved.schema.$ref
      if (typeof next !== "string") return
      current = next
    }
  })
  return [...problems].sort()
}

/**
 * Visit every subschema reachable from `schema` once, with its dotted path.
 * Shared by the unsupported-keyword and $ref collectors so both see exactly the
 * same set of nodes - including the ones inside $defs/definitions, so a keyword
 * the validator cannot evaluate is still caught when it hides in a definition.
 */
function forEachSubschema(
  schema: JsonSchemaLike,
  visit: (node: JsonSchemaLike, path: string) => void,
): void {
  const seen = new Set<unknown>()
  const walk = (node: unknown, path: string): void => {
    if (typeof node !== "object" || node === null || Array.isArray(node)) return
    if (seen.has(node)) return
    seen.add(node)
    const record = node as JsonSchemaLike
    visit(record, path)
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
}

/**
 * Schemas currently being evaluated against a given value, used to spot a $ref
 * that loops without consuming anything. Keyed by the resolved subschema so two
 * different values validated against the same node never collide.
 */
type RefTrail = Map<JsonSchemaLike, Set<unknown>>

export type RefResolution = { ok: true; schema: JsonSchemaLike } | { ok: false; error: string }

/**
 * Resolve an internal JSON pointer against the schema document it appears in.
 * "#" and "" are the whole document (that is how a recursive root ref is
 * written); "#/a/b" walks the pointer with RFC 6901 unescaping.
 *
 * Percent-encoding is deliberately NOT decoded: only ~0/~1 are pointer escapes,
 * and decoding %xx would mangle a property name that legitimately contains "%".
 */
export function resolveRef(ref: string, root: JsonSchemaLike): RefResolution {
  if (ref === "" || ref === "#") return { ok: true, schema: root }
  if (!ref.startsWith("#")) {
    return {
      ok: false,
      error: `external $ref ${JSON.stringify(ref)} cannot be resolved - this validator does not fetch documents; inline it or use an internal ref like "#/$defs/Name"`,
    }
  }
  if (!ref.startsWith("#/")) {
    return {
      ok: false,
      error: `$ref ${JSON.stringify(ref)} names an $anchor, which is not supported - use a JSON pointer like "#/$defs/Name"`,
    }
  }
  let node: unknown = root
  for (const segment of ref.slice(2).split("/")) {
    const key = unescapePointer(segment)
    if (Array.isArray(node)) {
      const index = Number(key)
      if (!Number.isInteger(index) || index < 0 || index >= node.length) {
        return { ok: false, error: `$ref ${JSON.stringify(ref)} does not resolve (no ${JSON.stringify(key)})` }
      }
      node = node[index]
      continue
    }
    if (typeof node !== "object" || node === null || !Object.hasOwn(node, key)) {
      return { ok: false, error: `$ref ${JSON.stringify(ref)} does not resolve (no ${JSON.stringify(key)})` }
    }
    node = (node as Record<string, unknown>)[key]
  }
  if (typeof node !== "object" || node === null || Array.isArray(node)) {
    return { ok: false, error: `$ref ${JSON.stringify(ref)} points at ${JSON.stringify(node)}, which is not a schema object` }
  }
  return { ok: true, schema: node as JsonSchemaLike }
}

/** RFC 6901: ~1 before ~0, so "~01" yields the property named "~1". */
function unescapePointer(segment: string): string {
  return segment.replace(/~1/g, "/").replace(/~0/g, "~")
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
 * Ceiling on recursive descent, counting both $ref hops and value levels.
 *
 * Non-consuming $ref cycles are caught precisely by the refTrail in
 * validateAgainstSchema, so this is not the cycle guard - it is the guard
 * against blowing the JS call stack on a pathologically nested value, which
 * would otherwise surface as an uncatchable RangeError instead of a schema
 * error. Each value level costs a few frames, so this sits well below the
 * engine's real stack limit while leaving far more headroom than any schema a
 * model realistically emits.
 */
const MAX_VALIDATION_DEPTH = 1000

/**
 * JSON Schema validation covering everything workflow scripts can express:
 * type (including type arrays like ["string","null"]), properties, required,
 * additionalProperties, patternProperties, propertyNames,
 * minProperties/maxProperties, dependentRequired/dependentSchemas, items,
 * prefixItems, contains/minContains/maxContains, minItems/maxItems,
 * uniqueItems, enum, const, oneOf/anyOf/allOf/not, if/then/else, pattern,
 * minLength/maxLength, minimum/maximum/exclusiveMinimum/exclusiveMaximum,
 * multipleOf, and $ref into $defs/definitions or anywhere else in the same
 * document. Returns an error message or undefined when valid.
 *
 * `root` is the document $ref pointers resolve against; it defaults to `schema`
 * so the 3-argument call stays the public shape, and every recursive call
 * threads the ORIGINAL root through so a ref inside a $defs subschema still
 * resolves against the top-level document.
 *
 * `const` and `enum` deliberately short-circuit: they pin the value exactly,
 * so no other keyword can add information. `$ref` does not: 2020-12 evaluates
 * it as a conjunction with its siblings, so both are checked. Everything the
 * validator cannot evaluate is rejected up front by collectUnsupportedKeywords
 * rather than being ignored here.
 */
export function validateAgainstSchema(
  value: unknown,
  schema: JsonSchemaLike,
  path: string,
  root: JsonSchemaLike = schema,
  depth = 0,
  refTrail?: RefTrail,
): string | undefined {
  if (depth > MAX_VALIDATION_DEPTH) {
    return `${path} exceeded ${MAX_VALIDATION_DEPTH} levels of schema nesting - the schema has a $ref cycle that never consumes a value`
  }
  if (typeof schema.$ref === "string") {
    const resolved = resolveRef(schema.$ref, root)
    if (!resolved.ok) return `${path}: ${resolved.error}`
    // A $ref that lands on a schema already being evaluated FOR THIS SAME VALUE
    // never consumed anything, so following it again would not terminate. That
    // is the real cycle test; the depth counter alone cannot tell a cycle from
    // legitimate recursion, because a deeply nested value costs several schema
    // steps per level and would trip the ceiling on its own.
    const trail = refTrail ?? new Map<JsonSchemaLike, Set<unknown>>()
    const seenValues = trail.get(resolved.schema)
    if (seenValues?.has(value)) {
      return `${path} has a $ref cycle that never consumes a value ("${schema.$ref}")`
    }
    if (seenValues) seenValues.add(value)
    else trail.set(resolved.schema, new Set([value]))
    const problem = validateAgainstSchema(value, resolved.schema, path, root, depth + 1, trail)
    // Popped so a sibling branch validating the same value against the same
    // subschema is not mistaken for a cycle.
    trail.get(resolved.schema)?.delete(value)
    if (problem) return problem
    const siblings = { ...schema }
    delete siblings.$ref
    if (Object.keys(siblings).length === 0) return undefined
    return validateAgainstSchema(value, siblings, path, root, depth + 1, refTrail)
  }
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
  if (schema.not && validateAgainstSchema(value, schema.not, path, root, depth + 1) === undefined) {
    return `${path} must not match the "not" schema`
  }
  if (schema.if) {
    const branch = validateAgainstSchema(value, schema.if, path, root, depth + 1) === undefined
      ? schema.then
      : schema.else
    if (branch) {
      const problem = validateAgainstSchema(value, branch, path, root, depth + 1)
      if (problem) return problem
    }
  }
  if (schema.allOf) {
    for (const sub of schema.allOf) {
      const problem = validateAgainstSchema(value, sub, path, root, depth + 1)
      if (problem) return problem
    }
  }
  if (schema.anyOf) {
    const errors = schema.anyOf.map((sub) => validateAgainstSchema(value, sub, path, root, depth + 1))
    if (!errors.some((error) => error === undefined)) {
      return `${path} must match at least one schema in anyOf (closest: ${errors[0]})`
    }
  }
  if (schema.oneOf) {
    const matched = schema.oneOf.filter(
      (sub) => validateAgainstSchema(value, sub, path, root, depth + 1) === undefined,
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
      const problem = validateObject(value as Record<string, unknown>, schema, path, root, depth)
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
      const problem = validateArray(value, schema, path, root, depth)
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
  root: JsonSchemaLike,
  depth: number,
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
      const problem = validateAgainstSchema(record[key], child, `${path}.${key}`, root, depth + 1)
      if (problem) return problem
    }
  }
  const patterns = Object.entries(schema.patternProperties ?? {})
  for (const [pattern, child] of patterns) {
    const regex = compilePattern(pattern)
    if (!regex) return `${path} has an invalid patternProperties pattern in its schema: ${pattern}`
    for (const key of keys) {
      if (!regex.test(key)) continue
      const problem = validateAgainstSchema(record[key], child, `${path}.${key}`, root, depth + 1)
      if (problem) return problem
    }
  }
  if (schema.propertyNames) {
    for (const key of keys) {
      const problem = validateAgainstSchema(key, schema.propertyNames, `${path} property name "${key}"`, root, depth + 1)
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
    const problem = validateAgainstSchema(record, child, path, root, depth + 1)
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
      const problem = validateAgainstSchema(record[key], schema.additionalProperties, `${path}.${key}`, root, depth + 1)
      if (problem) return problem
    }
  }
  return undefined
}

function validateArray(
  value: unknown[],
  schema: JsonSchemaLike,
  path: string,
  root: JsonSchemaLike,
  depth: number,
): string | undefined {
  if (schema.minItems !== undefined && value.length < schema.minItems) {
    return `${path} must have at least ${schema.minItems} items, got ${value.length}`
  }
  if (schema.maxItems !== undefined && value.length > schema.maxItems) {
    return `${path} must have at most ${schema.maxItems} items, got ${value.length}`
  }
  const prefix = schema.prefixItems ?? []
  for (let index = 0; index < prefix.length && index < value.length; index += 1) {
    const problem = validateAgainstSchema(value[index], prefix[index] as JsonSchemaLike, `${path}[${index}]`, root, depth + 1)
    if (problem) return problem
  }
  if (schema.items) {
    // With prefixItems present, `items` constrains only the tail, per 2020-12.
    for (let index = prefix.length; index < value.length; index += 1) {
      const problem = validateAgainstSchema(value[index], schema.items, `${path}[${index}]`, root, depth + 1)
      if (problem) return problem
    }
  }
  if (schema.contains) {
    const matches = value.filter(
      (entry, index) => validateAgainstSchema(entry, schema.contains as JsonSchemaLike, `${path}[${index}]`, root, depth + 1) === undefined,
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

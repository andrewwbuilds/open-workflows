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
  const validated = validateMeta(parsePureLiteral(literal))

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
 * Parse a meta literal as pure data.
 *
 * This is a real recursive-descent parser rather than a regex screen plus
 * `new Function`, because the regex screen was wrong in both directions: it
 * accepted `{ n: 1 + 1 }` and computed keys like `{ ['na' + 'me']: 'a' }` (any
 * identifier that also appeared as a key elsewhere slipped through), while
 * rejecting an interpolation-free template literal outright. Only object and
 * array literals, strings, numbers, `true`, `false` and `null` are accepted;
 * anything else - a call, a variable, a spread, arithmetic, a computed key, a
 * template with `${}` - is a syntax error here, so the literal is never
 * evaluated as code.
 */
export function parsePureLiteral(literal: string): unknown {
  const parser = new LiteralParser(literal)
  const value = parser.parseValue()
  parser.skipTrivia()
  if (!parser.atEnd()) parser.fail("unexpected trailing content")
  return value
}

class LiteralParser {
  private readonly source: string
  private index = 0

  constructor(source: string) {
    this.source = source
  }

  atEnd(): boolean {
    return this.index >= this.source.length
  }

  fail(detail: string): never {
    throw new Error(
      `Workflow meta must be a pure literal - ${detail} at offset ${this.index}.`,
    )
  }

  skipTrivia(): void {
    while (this.index < this.source.length) {
      const char = this.source[this.index] as string
      if (char === " " || char === "\t" || char === "\n" || char === "\r") {
        this.index += 1
        continue
      }
      if (char === "/" && this.source[this.index + 1] === "/") {
        this.index = skipLineComment(this.source, this.index)
        continue
      }
      if (char === "/" && this.source[this.index + 1] === "*") {
        this.index = skipBlockComment(this.source, this.index)
        continue
      }
      return
    }
  }

  parseValue(): unknown {
    this.skipTrivia()
    if (this.atEnd()) this.fail("unexpected end of literal")
    const char = this.source[this.index] as string
    if (char === "{") return this.parseObject()
    if (char === "[") return this.parseArray()
    if (char === '"' || char === "'" || char === "`") return this.parseString()
    if (char === "-" || (char >= "0" && char <= "9")) return this.parseNumber()
    const word = this.readWord()
    if (word === "true") return true
    if (word === "false") return false
    if (word === "null") return null
    if (word === "") this.fail(`unexpected "${char}"`)
    this.fail(`unexpected identifier "${word}"`)
  }

  private parseObject(): Record<string, unknown> {
    this.index += 1
    const result: Record<string, unknown> = {}
    for (;;) {
      this.skipTrivia()
      if (this.atEnd()) this.fail("unterminated object literal")
      if (this.source[this.index] === "}") {
        this.index += 1
        return result
      }
      const key = this.parseKey()
      this.skipTrivia()
      if (this.source[this.index] !== ":") this.fail(`expected ":" after key "${key}"`)
      this.index += 1
      result[key] = this.parseValue()
      this.skipTrivia()
      const next = this.source[this.index]
      if (next === ",") {
        this.index += 1
        continue
      }
      if (next === "}") {
        this.index += 1
        return result
      }
      this.fail(`expected "," or "}" after the value for "${key}"`)
    }
  }

  private parseKey(): string {
    const char = this.source[this.index]
    if (char === '"' || char === "'" || char === "`") return this.parseString()
    if (char === "[") this.fail("computed keys are not allowed")
    if (char === ".") this.fail("spreads are not allowed")
    const word = this.readWord()
    if (word === "") this.fail(`unexpected "${char ?? "end of literal"}" where a key was expected`)
    return word
  }

  private parseArray(): unknown[] {
    this.index += 1
    const result: unknown[] = []
    for (;;) {
      this.skipTrivia()
      if (this.atEnd()) this.fail("unterminated array literal")
      if (this.source[this.index] === "]") {
        this.index += 1
        return result
      }
      if (this.source[this.index] === ".") this.fail("spreads are not allowed")
      result.push(this.parseValue())
      this.skipTrivia()
      const next = this.source[this.index]
      if (next === ",") {
        this.index += 1
        continue
      }
      if (next === "]") {
        this.index += 1
        return result
      }
      this.fail('expected "," or "]" after an array element')
    }
  }

  private parseString(): string {
    const quote = this.source[this.index] as string
    const end = skipString(this.source, this.index)
    const raw = this.source.slice(this.index + 1, end - 1)
    // A template literal is data only when it interpolates nothing; `${` means
    // the value depends on an expression, which meta must not contain.
    if (quote === "`" && /\$\{/.test(raw)) this.fail("template interpolation is not allowed")
    this.index = end
    return unescape(raw)
  }

  private parseNumber(): number {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(this.source.slice(this.index))
    if (!match) this.fail("invalid number literal")
    this.index += match[0].length
    return Number(match[0])
  }

  private readWord(): string {
    const match = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(this.source.slice(this.index))
    if (!match) return ""
    this.index += match[0].length
    return match[0]
  }
}

const ESCAPES: Record<string, string> = {
  n: "\n",
  t: "\t",
  r: "\r",
  b: "\b",
  f: "\f",
  v: "\v",
  "0": "\0",
}

function unescape(raw: string): string {
  let out = ""
  let index = 0
  while (index < raw.length) {
    const char = raw[index] as string
    if (char !== "\\") {
      out += char
      index += 1
      continue
    }
    const next = raw[index + 1]
    if (next === undefined) return out
    if (next === "u" && raw[index + 2] === "{") {
      const close = raw.indexOf("}", index + 3)
      if (close > 0) {
        out += String.fromCodePoint(Number.parseInt(raw.slice(index + 3, close), 16))
        index = close + 1
        continue
      }
    }
    if (next === "u") {
      out += String.fromCharCode(Number.parseInt(raw.slice(index + 2, index + 6), 16))
      index += 6
      continue
    }
    if (next === "x") {
      out += String.fromCharCode(Number.parseInt(raw.slice(index + 2, index + 4), 16))
      index += 4
      continue
    }
    out += ESCAPES[next] ?? next
    index += 2
  }
  return out
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

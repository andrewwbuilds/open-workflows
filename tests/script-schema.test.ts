import { describe, expect, it } from "vitest"
import { extractJson, parseWithSchema, validateAgainstSchema } from "../src/script/schema.js"

describe("extractJson", () => {
  it("parses bare JSON", () => {
    expect(extractJson('{"a": 1}')).toEqual({ a: 1 })
  })

  it("parses JSON inside markdown fences", () => {
    expect(extractJson('Here you go:\n```json\n{"a": 1}\n```\nDone.')).toEqual({ a: 1 })
  })

  it("parses JSON with surrounding prose", () => {
    expect(extractJson('The result is {"a": [1, 2]} as requested.')).toEqual({ a: [1, 2] })
  })

  it("returns undefined when no JSON exists", () => {
    expect(extractJson("no json here")).toBeUndefined()
  })
})

describe("validateAgainstSchema", () => {
  const schema = {
    type: "object",
    required: ["bugs"],
    properties: {
      bugs: {
        type: "array",
        items: {
          type: "object",
          required: ["file", "severity"],
          properties: {
            file: { type: "string" },
            severity: { enum: ["low", "high"] },
          },
        },
      },
    },
  }

  it("accepts matching values", () => {
    const value = { bugs: [{ file: "a.ts", severity: "high" }] }
    expect(validateAgainstSchema(value, schema, "$")).toBeUndefined()
  })

  it("reports missing required keys with a path", () => {
    expect(validateAgainstSchema({}, schema, "$")).toMatch(/\$\.bugs is required/)
  })

  it("reports nested item mismatches", () => {
    const value = { bugs: [{ file: "a.ts", severity: "medium" }] }
    expect(validateAgainstSchema(value, schema, "$")).toMatch(/severity/)
  })

  it("reports type mismatches", () => {
    expect(validateAgainstSchema({ bugs: "nope" }, schema, "$")).toMatch(/must be array/)
  })

  it("treats integer as number", () => {
    expect(validateAgainstSchema(3, { type: "integer" }, "$")).toBeUndefined()
  })
})

describe("parseWithSchema", () => {
  it("round-trips a fenced response", () => {
    const result = parseWithSchema('```json\n{"ok": true}\n```', {
      type: "object",
      required: ["ok"],
    })
    expect(result.ok).toBe(true)
    expect(result.value).toEqual({ ok: true })
  })

  it("fails with an error message on schema mismatch", () => {
    const result = parseWithSchema('{"other": 1}', { type: "object", required: ["ok"] })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/ok is required/)
  })
})

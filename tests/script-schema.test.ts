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

  describe("const", () => {
    it("accepts a deep-equal value regardless of key order", () => {
      const schema = { const: { a: 1, b: [2, 3] } }
      expect(validateAgainstSchema({ b: [2, 3], a: 1 }, schema, "$")).toBeUndefined()
    })

    it("rejects a different value with the expected constant", () => {
      expect(validateAgainstSchema("no", { const: "yes" }, "$")).toBe('$ must equal "yes"')
    })

    it("supports const null", () => {
      expect(validateAgainstSchema(null, { const: null }, "$")).toBeUndefined()
      expect(validateAgainstSchema(0, { const: null }, "$")).toBe("$ must equal null")
    })
  })

  describe("oneOf", () => {
    const schema = {
      oneOf: [
        { type: "string" },
        { type: "number", minimum: 10 },
      ],
    }

    it("accepts a value matching exactly one branch", () => {
      expect(validateAgainstSchema("hello", schema, "$")).toBeUndefined()
      expect(validateAgainstSchema(12, schema, "$")).toBeUndefined()
    })

    it("rejects a value matching no branch", () => {
      expect(validateAgainstSchema(3, schema, "$"))
        .toBe("$ must match exactly one schema in oneOf, matched 0")
    })

    it("rejects a value matching more than one branch", () => {
      const ambiguous = { oneOf: [{ type: "integer" }, { type: "number" }] }
      expect(validateAgainstSchema(5, ambiguous, "$"))
        .toBe("$ must match exactly one schema in oneOf, matched 2")
    })
  })

  describe("anyOf", () => {
    const schema = { anyOf: [{ type: "string" }, { type: "null" }] }

    it("accepts a value matching any branch", () => {
      expect(validateAgainstSchema("ok", schema, "$")).toBeUndefined()
      expect(validateAgainstSchema(null, schema, "$")).toBeUndefined()
    })

    it("rejects a value matching no branch with the closest error", () => {
      expect(validateAgainstSchema(7, { anyOf: [{ type: "string" }] }, "$.field"))
        .toBe("$.field must match at least one schema in anyOf (closest: $.field must be string, got number)")
    })
  })

  describe("allOf", () => {
    const schema = {
      allOf: [
        { type: "object", required: ["a"] },
        { type: "object", required: ["b"] },
      ],
    }

    it("accepts a value matching every branch", () => {
      expect(validateAgainstSchema({ a: 1, b: 2 }, schema, "$")).toBeUndefined()
    })

    it("rejects with the first failing branch's error", () => {
      expect(validateAgainstSchema({ a: 1 }, schema, "$")).toBe("$.b is required")
    })
  })

  describe("pattern", () => {
    it("accepts matching strings", () => {
      expect(validateAgainstSchema("abc-123", { type: "string", pattern: "^[a-z]+-\\d+$" }, "$")).toBeUndefined()
    })

    it("rejects non-matching strings", () => {
      expect(validateAgainstSchema("nope", { type: "string", pattern: "^\\d+$" }, "$.id"))
        .toBe("$.id must match pattern ^\\d+$")
    })

    it("reports invalid pattern schemas instead of throwing", () => {
      expect(validateAgainstSchema("x", { type: "string", pattern: "(" }, "$"))
        .toBe("$ has an invalid pattern in its schema: (")
    })
  })

  describe("minLength / maxLength", () => {
    it("accepts strings within bounds", () => {
      expect(validateAgainstSchema("abc", { type: "string", minLength: 2, maxLength: 4 }, "$")).toBeUndefined()
    })

    it("rejects strings that are too short", () => {
      expect(validateAgainstSchema("a", { type: "string", minLength: 2 }, "$.name"))
        .toBe("$.name must be at least 2 characters, got 1")
    })

    it("rejects strings that are too long", () => {
      expect(validateAgainstSchema("abcde", { type: "string", maxLength: 4 }, "$.name"))
        .toBe("$.name must be at most 4 characters, got 5")
    })
  })

  describe("numeric bounds", () => {
    it("accepts numbers within bounds", () => {
      expect(validateAgainstSchema(5, { type: "number", minimum: 5, maximum: 5 }, "$")).toBeUndefined()
    })

    it("rejects numbers below minimum", () => {
      expect(validateAgainstSchema(1, { type: "number", minimum: 2 }, "$.n")).toBe("$.n must be >= 2, got 1")
    })

    it("rejects numbers above maximum", () => {
      expect(validateAgainstSchema(9, { type: "number", maximum: 8 }, "$.n")).toBe("$.n must be <= 8, got 9")
    })

    it("rejects numbers at or below exclusiveMinimum", () => {
      expect(validateAgainstSchema(2, { type: "number", exclusiveMinimum: 2 }, "$.n"))
        .toBe("$.n must be > 2, got 2")
    })

    it("rejects numbers at or above exclusiveMaximum", () => {
      expect(validateAgainstSchema(8, { type: "number", exclusiveMaximum: 8 }, "$.n"))
        .toBe("$.n must be < 8, got 8")
    })
  })

  describe("minItems / maxItems", () => {
    it("accepts arrays within bounds", () => {
      expect(validateAgainstSchema([1, 2], { type: "array", minItems: 1, maxItems: 3 }, "$")).toBeUndefined()
    })

    it("rejects arrays with too few items", () => {
      expect(validateAgainstSchema([], { type: "array", minItems: 1 }, "$.list"))
        .toBe("$.list must have at least 1 items, got 0")
    })

    it("rejects arrays with too many items", () => {
      expect(validateAgainstSchema([1, 2, 3], { type: "array", maxItems: 2 }, "$.list"))
        .toBe("$.list must have at most 2 items, got 3")
    })
  })

  describe("additionalProperties", () => {
    const schema = {
      type: "object",
      properties: { known: { type: "string" } },
      additionalProperties: false,
    }

    it("accepts objects with only declared keys", () => {
      expect(validateAgainstSchema({ known: "yes" }, schema, "$")).toBeUndefined()
    })

    it("rejects unknown keys with a path", () => {
      expect(validateAgainstSchema({ known: "yes", extra: 1 }, schema, "$"))
        .toBe("$.extra is not an allowed property")
    })

    it("validates extra keys against an additionalProperties schema", () => {
      const withSchema = {
        type: "object",
        properties: { known: { type: "string" } },
        additionalProperties: { type: "number" },
      }
      expect(validateAgainstSchema({ known: "a", extra: 2 }, withSchema, "$")).toBeUndefined()
      expect(validateAgainstSchema({ known: "a", extra: "b" }, withSchema, "$"))
        .toBe("$.extra must be number, got string")
    })
  })

  describe("type arrays", () => {
    it("accepts any listed type", () => {
      const schema = { type: ["string", "null"] }
      expect(validateAgainstSchema("hi", schema, "$")).toBeUndefined()
      expect(validateAgainstSchema(null, schema, "$")).toBeUndefined()
    })

    it("rejects unlisted types with the full list", () => {
      expect(validateAgainstSchema(1, { type: ["string", "null"] }, "$.v"))
        .toBe("$.v must be string or null, got number")
    })

    it("skips object constraints when a nullable object is null", () => {
      const schema = {
        type: ["object", "null"],
        required: ["a"],
        properties: { a: { type: "number" } },
      }
      expect(validateAgainstSchema(null, schema, "$")).toBeUndefined()
      expect(validateAgainstSchema({}, schema, "$")).toBe("$.a is required")
    })

    it("skips array constraints when a nullable array is null", () => {
      const schema = { type: ["array", "null"], items: { type: "number" }, minItems: 1 }
      expect(validateAgainstSchema(null, schema, "$")).toBeUndefined()
      expect(validateAgainstSchema([], schema, "$")).toBe("$ must have at least 1 items, got 0")
    })
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

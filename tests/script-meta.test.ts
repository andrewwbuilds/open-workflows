import { describe, expect, it } from "vitest"
import { parseWorkflowScript } from "../src/script/meta.js"

describe("parseWorkflowScript", () => {
  it("parses meta and strips it from the body", () => {
    const script = [
      "export const meta = {",
      "  name: 'review-changes',",
      "  description: 'Review changed files',",
      "  phases: [{ title: 'Review', detail: 'find issues' }, { title: 'Verify' }],",
      "}",
      "phase('Review')",
      "return 42",
    ].join("\n")
    const { meta, body } = parseWorkflowScript(script)
    expect(meta.name).toBe("review-changes")
    expect(meta.description).toBe("Review changed files")
    expect(meta.phases).toEqual([
      { title: "Review", detail: "find issues", model: undefined },
      { title: "Verify", detail: undefined, model: undefined },
    ])
    expect(body).not.toContain("export const meta")
    expect(body).toContain("phase('Review')")
    expect(body).toContain("return 42")
  })

  it("accepts a trailing semicolon and double-quoted strings with braces", () => {
    const script = `export const meta = { name: "x", description: "has { braces } and : colons" };\nreturn 1`
    const { meta, body } = parseWorkflowScript(script)
    expect(meta.description).toContain("{ braces }")
    expect(body.trim()).toBe("return 1")
  })

  it("rejects scripts without a meta block", () => {
    expect(() => parseWorkflowScript("return 1")).toThrow(/must begin with/)
  })

  it("rejects meta with computed values", () => {
    expect(() =>
      parseWorkflowScript("export const meta = { name: getName(), description: 'x' }\nreturn 1"),
    ).toThrow(/pure literal/)
  })

  it("rejects meta with identifiers as values", () => {
    expect(() =>
      parseWorkflowScript("export const meta = { name: someVar, description: 'x' }\nreturn 1"),
    ).toThrow(/pure literal/)
  })

  it("rejects meta with spreads", () => {
    expect(() =>
      parseWorkflowScript("export const meta = { ...base, name: 'x', description: 'y' }\nreturn 1"),
    ).toThrow(/pure literal/)
  })

  it("rejects unbalanced meta literals", () => {
    expect(() =>
      parseWorkflowScript("export const meta = { name: 'x', description: 'y'"),
    ).toThrow(/not balanced/)
  })

  it("requires name and description", () => {
    expect(() => parseWorkflowScript("export const meta = { name: 'x' }\nreturn 1")).toThrow(
      /description/,
    )
    expect(() =>
      parseWorkflowScript("export const meta = { description: 'x' }\nreturn 1"),
    ).toThrow(/name/)
  })

  it("validates phase entries", () => {
    expect(() =>
      parseWorkflowScript(
        "export const meta = { name: 'x', description: 'y', phases: [{ detail: 'no title' }] }\nreturn 1",
      ),
    ).toThrow(/title/)
  })
})

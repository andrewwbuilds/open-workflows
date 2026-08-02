import { describe, expect, it } from "vitest"
import { parseStructuredOutput, isPlannerOutput, isReviewerOutput, isWorkerOutput } from "../src/util/parse.js"
import { buildFallbackPlannerOutput, buildFallbackReviewerOutput, buildFallbackWorkerOutput } from "../src/prompts.js"

describe("parse helpers", () => {
  it("parses plain JSON", () => {
    const value = parseStructuredOutput('{"plan":[],"rationale":"r"}', isPlannerOutput)
    expect(value?.plan).toEqual([])
  })

  it("extracts JSON from a fenced code block", () => {
    const text = "Here you go:\n```json\n{\"plan\":[],\"rationale\":\"r\"}\n```\nThanks."
    const value = parseStructuredOutput(text, isPlannerOutput)
    expect(value?.plan).toEqual([])
  })

  it("extracts JSON embedded in prose", () => {
    const text = 'Some text {"status":"pass","summary":"ok","followUps":[],"criteriaMet":[],"criteriaMissed":[]} tail'
    const value = parseStructuredOutput(text, isReviewerOutput)
    expect(value?.status).toBe("pass")
  })

  it("returns undefined for invalid payloads", () => {
    expect(parseStructuredOutput("hello", isPlannerOutput)).toBeUndefined()
  })

  it("recognizes worker output", () => {
    const value = parseStructuredOutput('{"status":"blocked","summary":"nope"}', isWorkerOutput)
    expect(value?.status).toBe("blocked")
  })

  it("falls back when review is not parseable", () => {
    const fallback = buildFallbackReviewerOutput("default text")
    expect(fallback.status).toBe("needs-attention")
    expect(fallback.summary).toBe("default text")
  })

  it("falls back when worker is not parseable", () => {
    const fallback = buildFallbackWorkerOutput("summary")
    expect(fallback.status).toBe("completed")
  })

  it("falls back when planner is not parseable", () => {
    const fallback = buildFallbackPlannerOutput()
    expect(fallback.plan).toEqual([])
  })
})

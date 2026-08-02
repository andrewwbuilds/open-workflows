import { describe, expect, it } from "vitest"
import { parseModel } from "../src/runtime/sdk.js"

describe("parseModel", () => {
  it("splits a provider and model id", () => {
    const result = parseModel("anthropic/claude-sonnet-4-5")
    expect(result).toEqual({ providerID: "anthropic", modelID: "claude-sonnet-4-5" })
  })

  it("rejects malformed values", () => {
    expect(() => parseModel("anthropic")).toThrow(/Invalid model/)
    expect(() => parseModel("/model")).toThrow(/Invalid model/)
    expect(() => parseModel("provider/")).toThrow(/Invalid model/)
  })
})

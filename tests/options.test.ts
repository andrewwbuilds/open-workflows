import { describe, expect, it } from "vitest"
import { resolveOptions } from "../src/options.js"

describe("resolveOptions", () => {
  it("applies defaults for missing fields", () => {
    const resolved = resolveOptions(undefined)
    expect(resolved.mode).toBe("research")
    expect(resolved.allowEdits).toBe(false)
    expect(resolved.maxRounds).toBeGreaterThanOrEqual(1)
    expect(resolved.maxWorkers).toBeGreaterThanOrEqual(1)
    expect(resolved.maxTasks).toBeGreaterThanOrEqual(1)
    expect(resolved.parallelWorkers).toBe(true)
  })

  it("clamps values to safe bounds", () => {
    const resolved = resolveOptions({
      maxRounds: 1000,
      maxWorkers: 999,
      maxTasks: 999,
    })
    expect(resolved.maxRounds).toBeLessThanOrEqual(10)
    expect(resolved.maxWorkers).toBeLessThanOrEqual(8)
    expect(resolved.maxTasks).toBeLessThanOrEqual(50)
  })

  it("uses provided values when in range", () => {
    const resolved = resolveOptions({
      mode: "implement",
      allowEdits: true,
      maxRounds: 5,
      maxWorkers: 4,
      maxTasks: 10,
      parallelWorkers: false,
      plannerAgent: "plan",
      workerAgent: "general",
      reviewerAgent: "general",
      model: "anthropic/claude-sonnet-4-5",
      successCriteria: ["a", "b"],
    })
    expect(resolved.mode).toBe("implement")
    expect(resolved.allowEdits).toBe(true)
    expect(resolved.maxRounds).toBe(5)
    expect(resolved.parallelWorkers).toBe(false)
    expect(resolved.model).toBe("anthropic/claude-sonnet-4-5")
    expect(resolved.successCriteria).toEqual(["a", "b"])
  })
})

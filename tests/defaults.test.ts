import { describe, expect, it } from "vitest"
import { cpus } from "node:os"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { DEFAULT_CONCURRENCY } from "../src/script/engine.js"
import { loadWorkflowAssets } from "../src/assets.js"

/**
 * These defaults deliberately track Claude Code's workflow defaults, so that a
 * script written against one behaves the same against the other.
 */
describe("Claude Code-aligned defaults", () => {
  it("caps concurrent agents at min(16, cores - 2)", () => {
    expect(DEFAULT_CONCURRENCY).toBe(Math.min(16, Math.max(1, cpus().length - 2)))
    expect(DEFAULT_CONCURRENCY).toBeGreaterThanOrEqual(1)
    expect(DEFAULT_CONCURRENCY).toBeLessThanOrEqual(16)
  })
})

describe("packaged agents inherit the session model", () => {
  const agents = ["workflow-planner", "workflow-worker", "workflow-reviewer"]

  for (const agent of agents) {
    it(`${agent}.md pins no provider-specific model`, () => {
      // Claude Code's default is to inherit the main-loop model rather than
      // name one. Pinning e.g. anthropic/* here would also break the plugin's
      // "works with any model provider" promise for non-Anthropic setups.
      const file = readFileSync(resolve(`agents/${agent}.md`), "utf8")
      const frontmatter = /^---([\s\S]+?)---/.exec(file)?.[1] ?? ""
      expect(frontmatter).not.toMatch(/^model:/m)
    })
  }

  it("registers no model field through the config hook", () => {
    const assets = loadWorkflowAssets(resolve("."))
    for (const agent of agents) {
      expect(assets.agents[agent]).toBeDefined()
      expect(assets.agents[agent]?.model).toBeUndefined()
    }
  })

  it("still registers the prompt and permissions", () => {
    const assets = loadWorkflowAssets(resolve("."))
    for (const agent of agents) {
      expect(assets.agents[agent]?.prompt.length).toBeGreaterThan(0)
      expect(assets.agents[agent]?.permission).toBeTruthy()
    }
  })
})

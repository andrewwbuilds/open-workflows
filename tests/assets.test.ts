import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

describe("command template", () => {
  it("references dynamic_workflow and exposes $ARGUMENTS", () => {
    const file = readFileSync(resolve("commands/workflow.md"), "utf8")
    expect(file).toContain("dynamic_workflow")
    expect(file).toContain("$ARGUMENTS")
    expect(file).toMatch(/^---[\s\S]+---/)
  })

  it("ships the frontmatter fields OpenCode expects", () => {
    const file = readFileSync(resolve("commands/workflow.md"), "utf8")
    const match = file.match(/^---([\s\S]+?)---/)
    expect(match).not.toBeNull()
    const frontmatter = match?.[1] ?? ""
    expect(frontmatter).toMatch(/description:/)
    expect(frontmatter).toMatch(/agent:\s*build/)
  })
})

describe("agent definitions", () => {
  const agents = ["workflow-planner", "workflow-worker", "workflow-reviewer"]
  for (const agent of agents) {
    it(`ships ${agent}.md with valid frontmatter`, () => {
      const file = readFileSync(resolve(`agents/${agent}.md`), "utf8")
      const match = file.match(/^---([\s\S]+?)---/)
      expect(match).not.toBeNull()
      const frontmatter = match?.[1] ?? ""
      expect(frontmatter).toMatch(/description:/)
      expect(frontmatter).toMatch(/mode:\s*subagent/)
      expect(frontmatter).toMatch(/task:\s*deny/)
    })
  }
})
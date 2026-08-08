import { describe, expect, it } from "vitest"
import { applyWorkflowConfig } from "../src/config.js"
import { loadWorkflowAssets, parseMarkdownAsset } from "../src/assets.js"
import { fileURLToPath } from "node:url"

const repoRoot = fileURLToPath(new URL("..", import.meta.url))

describe("parseMarkdownAsset", () => {
  it("parses flat frontmatter and body", () => {
    const raw = "---\ndescription: A test agent\nmode: subagent\n---\n\nPrompt body here.\n"
    const parsed = parseMarkdownAsset(raw)
    expect(parsed.frontmatter).toEqual({ description: "A test agent", mode: "subagent" })
    expect(parsed.body).toBe("Prompt body here.")
  })

  it("parses one nested level (permission)", () => {
    const raw = [
      "---",
      "description: x",
      "permission:",
      "  edit: deny",
      "  bash: ask",
      "---",
      "Body",
    ].join("\n")
    const parsed = parseMarkdownAsset(raw)
    expect(parsed.frontmatter.permission).toEqual({ edit: "deny", bash: "ask" })
  })

  it("returns the whole document as body without frontmatter", () => {
    const parsed = parseMarkdownAsset("Just a body.")
    expect(parsed.frontmatter).toEqual({})
    expect(parsed.body).toBe("Just a body.")
  })
})

describe("loadWorkflowAssets", () => {
  it("loads the packaged agents and commands", () => {
    const assets = loadWorkflowAssets(repoRoot)
    expect(Object.keys(assets.agents).sort()).toEqual([
      "code-reviewer",
      "workflow-planner",
      "workflow-reviewer",
      "workflow-worker",
    ])
    const reviewer = assets.agents["code-reviewer"]
    expect(reviewer?.mode).toBe("subagent")
    // `edit: deny` is what makes the packaged reviewer read-only.
    expect(reviewer?.permission?.edit).toBe("deny")
    expect(Object.keys(assets.commands)).toEqual(["workflow"])
    const planner = assets.agents["workflow-planner"]
    expect(planner?.mode).toBe("subagent")
    expect(planner?.description).toContain("Planner")
    expect(planner?.prompt).toContain("planner")
    expect(planner?.permission).toEqual({ edit: "deny", bash: "deny", task: "deny" })
    const command = assets.commands["workflow"]
    expect(command?.template).toContain("dynamic_workflow")
    expect(command?.agent).toBe("build")
  })

  it("returns empty assets for a directory without agents/commands", () => {
    const assets = loadWorkflowAssets("/nonexistent-path-for-test")
    expect(assets.agents).toEqual({})
    expect(assets.commands).toEqual({})
  })
})

describe("applyWorkflowConfig", () => {
  it("registers packaged agents and commands into the config", () => {
    const config: Record<string, unknown> = {}
    applyWorkflowConfig(config, loadWorkflowAssets(repoRoot))
    const agents = config.agent as Record<string, unknown>
    const commands = config.command as Record<string, unknown>
    expect(Object.keys(agents)).toContain("workflow-planner")
    expect(Object.keys(commands)).toContain("workflow")
  })

  it("lets user fields win without dropping packaged fields", () => {
    const config: Record<string, unknown> = {
      agent: { "workflow-planner": { model: "anthropic/claude-opus-5" } },
      command: { workflow: { template: "custom template" } },
    }
    applyWorkflowConfig(config, loadWorkflowAssets(repoRoot))
    const agents = config.agent as Record<string, Record<string, unknown>>
    const commands = config.command as Record<string, { template: string }>
    const planner = agents["workflow-planner"]
    expect(planner?.model).toBe("anthropic/claude-opus-5")
    expect(planner?.prompt).toContain("planner")
    expect(planner?.permission).toEqual({ edit: "deny", bash: "deny", task: "deny" })
    expect(commands.workflow?.template).toBe("custom template")
    expect(Object.keys(agents)).toContain("workflow-worker")
  })

  it("leaves non-object user entries (e.g. disable flags) untouched", () => {
    const config: Record<string, unknown> = {
      agent: { "workflow-planner": false },
    }
    applyWorkflowConfig(config, loadWorkflowAssets(repoRoot))
    const agents = config.agent as Record<string, unknown>
    expect(agents["workflow-planner"]).toBe(false)
    expect(Object.keys(agents)).toContain("workflow-worker")
  })

  it("lets a user disable the packaged code-reviewer", () => {
    const config: Record<string, unknown> = {
      agent: { "code-reviewer": false },
    }
    applyWorkflowConfig(config, loadWorkflowAssets(repoRoot))
    const agents = config.agent as Record<string, unknown>
    expect(agents["code-reviewer"]).toBe(false)
  })

  it("leaves config untouched when assets are empty", () => {
    const config: Record<string, unknown> = {}
    applyWorkflowConfig(config, { agents: {}, commands: {} })
    expect(config.agent).toBeUndefined()
    expect(config.command).toBeUndefined()
  })
})

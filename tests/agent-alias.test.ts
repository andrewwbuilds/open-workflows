import { describe, expect, it } from "vitest"
import { resolveAgentType } from "../src/script/agent-alias.js"

const REGISTRY = ["build", "plan", "general", "explore", "code-reviewer"]

describe("resolveAgentType", () => {
  it("returns a registered agent verbatim, with no alias record", () => {
    expect(resolveAgentType("plan", REGISTRY)).toEqual({ ok: true, agent: "plan" })
    expect(resolveAgentType("code-reviewer", REGISTRY)).toEqual({ ok: true, agent: "code-reviewer" })
    expect(resolveAgentType("general", REGISTRY)).toEqual({ ok: true, agent: "general" })
  })

  it("lets a user's own agent shadow an alias key", () => {
    // Someone who literally defined "general-purpose" must get theirs.
    expect(resolveAgentType("general-purpose", ["general", "general-purpose"])).toEqual({
      ok: true,
      agent: "general-purpose",
    })
  })

  it("maps Claude Code's names onto OpenCode's agents", () => {
    expect(resolveAgentType("general-purpose", REGISTRY)).toEqual({
      ok: true,
      agent: "general",
      aliasedFrom: "general-purpose",
    })
    expect(resolveAgentType("claude", REGISTRY)).toEqual({
      ok: true,
      agent: "general",
      aliasedFrom: "claude",
    })
  })

  it("folds case against the registry so Explore and Plan resolve", () => {
    expect(resolveAgentType("Explore", REGISTRY)).toEqual({
      ok: true,
      agent: "explore",
      aliasedFrom: "Explore",
    })
    expect(resolveAgentType("Plan", REGISTRY)).toEqual({
      ok: true,
      agent: "plan",
      aliasedFrom: "Plan",
    })
    expect(resolveAgentType("myagent", ["general", "MyAgent"])).toEqual({
      ok: true,
      agent: "MyAgent",
      aliasedFrom: "myagent",
    })
  })

  it("still renames when the registry cannot be read", () => {
    // The identity entries for explore/plan are load-bearing here: the
    // case-insensitive fold has no registry to fold against.
    expect(resolveAgentType("Explore", undefined)).toEqual({
      ok: true,
      agent: "explore",
      aliasedFrom: "Explore",
    })
    expect(resolveAgentType("general-purpose", undefined)).toEqual({
      ok: true,
      agent: "general",
      aliasedFrom: "general-purpose",
    })
    expect(resolveAgentType("custom-thing", undefined)).toEqual({ ok: true, agent: "custom-thing" })
    expect(resolveAgentType("explore", undefined)).toEqual({ ok: true, agent: "explore" })
  })

  it("gives a Claude-Code-only agent its own error instead of a silent redirect", () => {
    const result = resolveAgentType("statusline-setup", REGISTRY)
    expect(result.ok).toBe(false)
    const message = result.ok ? "" : result.message
    expect(message).toContain("no OpenCode agent to map it onto")
    expect(message).not.toContain("unknown agentType")
    expect(resolveAgentType("output-style-setup", undefined).ok).toBe(false)
  })

  it("names the alias target when it is not installed", () => {
    const result = resolveAgentType("general-purpose", ["build"])
    expect(result.ok).toBe(false)
    const message = result.ok ? "" : result.message
    expect(message).toContain('"general-purpose"')
    expect(message).toContain('"general"')
    expect(message).toContain('"build"')
  })

  it("rejects an unknown name with no alias, listing what exists", () => {
    const result = resolveAgentType("code-revewer", REGISTRY)
    expect(result.ok).toBe(false)
    const message = result.ok ? "" : result.message
    expect(message).toContain('"code-revewer"')
    expect(message).toContain('"code-reviewer"')
  })

  it("cannot be tricked into an Object.prototype key", () => {
    expect(resolveAgentType("constructor", REGISTRY).ok).toBe(false)
    expect(resolveAgentType("toString", REGISTRY).ok).toBe(false)
    // With no registry there is nothing to validate against, so it passes
    // through unchanged rather than resolving to a prototype member.
    expect(resolveAgentType("constructor", undefined)).toEqual({ ok: true, agent: "constructor" })
  })
})

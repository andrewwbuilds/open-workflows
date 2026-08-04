import { readFileSync, readdirSync } from "node:fs"
import { join, basename } from "node:path"
import { fileURLToPath } from "node:url"

export interface ParsedMarkdownAsset {
  name: string
  frontmatter: Record<string, unknown>
  body: string
}

export interface AgentConfigEntry {
  description?: string
  mode?: string
  model?: string
  prompt: string
  permission?: Record<string, string>
  [key: string]: unknown
}

export interface CommandConfigEntry {
  template: string
  description?: string
  agent?: string
  model?: string
}

export interface WorkflowAssets {
  agents: Record<string, AgentConfigEntry>
  commands: Record<string, CommandConfigEntry>
}

/** Package root resolved from the compiled dist/ directory. */
export function packageRoot(): string {
  return fileURLToPath(new URL("..", import.meta.url))
}

/**
 * Load the packaged agent and command markdown so the plugin's `config` hook
 * can register them in-process - no postinstall file copying required.
 */
export function loadWorkflowAssets(root: string = packageRoot()): WorkflowAssets {
  const agents: Record<string, AgentConfigEntry> = {}
  const commands: Record<string, CommandConfigEntry> = {}
  for (const asset of readMarkdownDir(join(root, "agents"))) {
    agents[asset.name] = toAgentConfig(asset)
  }
  for (const asset of readMarkdownDir(join(root, "commands"))) {
    commands[asset.name] = toCommandConfig(asset)
  }
  return { agents, commands }
}

function toAgentConfig(asset: ParsedMarkdownAsset): AgentConfigEntry {
  const { description, mode, model, permission } = asset.frontmatter
  return {
    ...(typeof description === "string" ? { description } : {}),
    ...(typeof mode === "string" ? { mode } : {}),
    ...(typeof model === "string" ? { model } : {}),
    ...(isStringRecord(permission) ? { permission } : {}),
    prompt: asset.body,
  }
}

function toCommandConfig(asset: ParsedMarkdownAsset): CommandConfigEntry {
  const { description, agent, model } = asset.frontmatter
  return {
    template: asset.body,
    ...(typeof description === "string" ? { description } : {}),
    ...(typeof agent === "string" ? { agent } : {}),
    ...(typeof model === "string" ? { model } : {}),
  }
}

function readMarkdownDir(dir: string): ParsedMarkdownAsset[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  const assets: ParsedMarkdownAsset[] = []
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue
    try {
      const raw = readFileSync(join(dir, entry), "utf8")
      assets.push({ name: basename(entry, ".md"), ...parseMarkdownAsset(raw) })
    } catch {
      // Skip unreadable assets rather than failing plugin load.
    }
  }
  return assets
}

/**
 * Parse `---` frontmatter with a flat `key: value` shape plus one nested
 * level (e.g. `permission:`) - the subset these asset files use.
 */
export function parseMarkdownAsset(raw: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw)
  if (!match) {
    return { frontmatter: {}, body: raw.trim() }
  }
  const frontmatter: Record<string, unknown> = {}
  let nestedKey: string | undefined
  for (const line of match[1]?.split(/\r?\n/) ?? []) {
    if (line.trim() === "") continue
    const nested = /^\s+([A-Za-z_][\w-]*):\s*(.*)$/.exec(line)
    if (nested && nestedKey && /^\s/.test(line)) {
      const target = frontmatter[nestedKey]
      if (isStringRecord(target) && nested[1] !== undefined) {
        target[nested[1]] = (nested[2] ?? "").trim()
      }
      continue
    }
    const top = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line)
    if (!top || top[1] === undefined) continue
    const key = top[1]
    const value = (top[2] ?? "").trim()
    if (value === "") {
      frontmatter[key] = {}
      nestedKey = key
    } else {
      frontmatter[key] = value
      nestedKey = undefined
    }
  }
  return { frontmatter, body: raw.slice(match[0].length).trim() }
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

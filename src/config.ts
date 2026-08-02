import { loadWorkflowAssets, type WorkflowAssets } from "./assets.js"

interface ConfigLike {
  agent?: Record<string, unknown>
  command?: Record<string, unknown>
  [key: string]: unknown
}

/**
 * Register the packaged workflow agents and the /workflow command through the
 * plugin `config` hook. Entries already present in the user's config win, so
 * local overrides in ~/.config/opencode keep working.
 */
export function applyWorkflowConfig(
  config: ConfigLike,
  assets: WorkflowAssets = loadWorkflowAssets(),
): void {
  if (Object.keys(assets.agents).length > 0) {
    config.agent = mergeEntries(assets.agents, config.agent)
  }
  if (Object.keys(assets.commands).length > 0) {
    config.command = mergeEntries(assets.commands, config.command)
  }
}

/**
 * Per-entry field merge: a user entry overrides the packaged fields it sets
 * (e.g. just `model`) without losing the packaged prompt/permission/template.
 */
function mergeEntries(
  packaged: Record<string, unknown>,
  existing: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...(existing ?? {}) }
  for (const [name, entry] of Object.entries(packaged)) {
    const user = merged[name]
    if (user === undefined) {
      merged[name] = entry
    } else if (isRecord(user) && isRecord(entry)) {
      merged[name] = { ...entry, ...user }
    }
    // A non-object user value (e.g. false to disable) is left untouched.
  }
  return merged
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

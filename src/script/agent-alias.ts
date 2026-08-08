/**
 * Claude Code's Workflow scripts name subagents from ITS registry
 * ("general-purpose", "Explore", "Plan", "code-reviewer", "claude",
 * "statusline-setup"). None of those names exist in OpenCode, so a script
 * ported verbatim would be rejected by the registry check in engine.ts.
 *
 * The mapping lives here rather than in `config.agent` on purpose: registering
 * six Claude-Code-named agents would put them in the agent picker, in
 * `@`-mention completion and in the Task tool's subagent list for every user of
 * this plugin forever, including the ones who never port a script - and three
 * of them would be near-duplicates of agents OpenCode already ships
 * (`general`, `explore`, `plan`). Rewriting the name inside the engine costs a
 * Map lookup when it is used and nothing at all when it is not.
 *
 * Keys are matched case-insensitively: Claude Code's names are capitalised
 * ("Explore", "Plan") while every OpenCode built-in is lower-case. A Map rather
 * than an object literal, so `agentType: "constructor"` cannot hit
 * Object.prototype.
 *
 * `null` means "Claude Code has this agent and OpenCode has no honest
 * equivalent" - those get a specific error rather than being redirected to an
 * unrelated agent.
 *
 * `code-reviewer` is deliberately absent: this plugin packages a real
 * `code-reviewer` agent (agents/code-reviewer.md), so the exact-match branch
 * below resolves it without an alias.
 */
const CLAUDE_CODE_AGENT_ALIASES = new Map<string, string | null>([
  ["general-purpose", "general"],
  ["claude", "general"],
  // Identity entries: they exist for the registry-unreadable branch, where the
  // case-insensitive fold against the registry cannot run.
  ["explore", "explore"],
  ["plan", "plan"],
  ["statusline-setup", null],
  ["output-style-setup", null],
])

export type AgentTypeResolution =
  | { ok: true; agent: string; aliasedFrom?: string }
  | { ok: false; message: string }

/**
 * Resolve a script's `agentType` to an agent name OpenCode will accept.
 *
 * Returns a result rather than throwing so this module does not have to import
 * WorkflowUsageError from engine.ts (which imports this file); the caller wraps
 * `message`.
 *
 * `known` is runner.listAgents()'s answer: undefined means the registry could
 * not be read, which engine.ts already treats as "pass the agent through
 * unchecked" rather than a reason to fail the run.
 */
export function resolveAgentType(
  requested: string,
  known: readonly string[] | undefined,
): AgentTypeResolution {
  const alias = CLAUDE_CODE_AGENT_ALIASES.get(requested.toLowerCase())
  if (alias === null) {
    return {
      ok: false,
      message:
        `agent(): agentType ${JSON.stringify(requested)} is a Claude Code built-in that configures Claude Code itself, ` +
        "so there is no OpenCode agent to map it onto. Drop the option to use the workflow's default agent.",
    }
  }
  if (known === undefined) {
    // Nothing to validate against, so only the rename can be applied.
    return alias === undefined || alias === requested
      ? { ok: true, agent: requested }
      : { ok: true, agent: alias, aliasedFrom: requested }
  }
  // A real agent of that exact name always wins: a user who defined their own
  // "code-reviewer" or "plan" must get theirs, never an alias target.
  if (known.includes(requested)) return { ok: true, agent: requested }
  if (alias !== undefined && known.includes(alias)) {
    return { ok: true, agent: alias, aliasedFrom: requested }
  }
  // Claude Code's names are capitalised and OpenCode's built-ins are all
  // lower-case, so "Explore" must still find "explore". This also rescues a
  // user's own agent referenced with the wrong casing.
  const folded = known.find((name) => name.toLowerCase() === requested.toLowerCase())
  if (folded !== undefined) return { ok: true, agent: folded, aliasedFrom: requested }
  const hint =
    alias === undefined
      ? ""
      : ` Claude Code's ${JSON.stringify(requested)} maps to ${JSON.stringify(alias)}, which this OpenCode instance does not have.`
  return {
    ok: false,
    message:
      `agent(): unknown agentType ${JSON.stringify(requested)}.${hint}` +
      ` Known agents: ${known.map((name) => `"${name}"`).join(", ")}.`,
  }
}

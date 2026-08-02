# Changelog

## 0.2.0

- New `workflow` tool: executes Claude Code-compatible workflow scripts (`export const meta = {...}` plus `agent()`, `parallel()`, `pipeline()`, `phase()`, `log()`, `args`, `budget`) against OpenCode child sessions. Includes schema-forced structured output with in-session retry, a concurrency semaphore, a 1000-agent lifetime cap, 4096-item per-call limits, and a hard output-token budget.
- Live roadmap: both tools stream a Claude Code-style progress tree (phases, running agent labels, done/failed counts, recent logs) through tool metadata, so the OpenCode TUI shows workflow progress while it runs.
- Better install: the plugin now registers the `workflow-planner`/`workflow-worker`/`workflow-reviewer` agents and the `/workflow` command in-process via the plugin `config` hook. The npm `postinstall` file copy is gone (`npm run install-assets` remains as a manual fallback). User-defined agents/commands with the same names always win.
- `RunChildSessionResult` now carries `tokens` (input/output) from the child session for budget accounting.
- 58 new tests: meta parsing, script engine semantics (pipeline no-barrier, parallel error handling, schema retry, budget, caps, abort), roadmap rendering/throttling, and config-hook registration.
- Hardening from an adversarial multi-agent review of the engine (10 confirmed findings fixed, each with a regression test):
  - Cancellation now terminates the workflow: `parallel()`/`pipeline()` re-throw the dedicated `WorkflowAbortError` instead of degrading a user cancel to `null` items, and the SDK runner forwards the abort signal to `session.prompt` so in-flight child sessions actually stop.
  - A script failure aborts its in-flight `agent()` calls via an internal `AbortController`, and the progress reporter closes after `finish()` so stragglers can't re-invoke the metadata sink after the tool returns.
  - The token budget and abort state are re-checked when a queued `agent()` call acquires its concurrency slot, so concurrent fan-outs can no longer blow through the ceiling with stale counts.
  - `type: "integer"` schemas now reject fractional numbers.
  - The meta parser locates `export const meta =` at code level, ignoring occurrences inside comments and string literals.
  - A drained phase is marked done once the workflow moves past it (the roadmap no longer pins a stale phase as current).
  - Config-hook registration merges per-field, so a partial user override (e.g. just `model`) keeps the packaged prompt and permissions; `prepack` now builds `dist/` so published tarballs can't ship stale output.

## 0.1.3

- Edit tasks now run serially (the previous implementation only claimed serialization but allowed parallel execution).
- Reviewer `followUps` are seeded into the next round's planner prompt instead of being discarded.
- `formatWorkflowResult` shows review follow-ups, met/missed criteria, and round summaries.
- Tool description is more directive so the model picks `dynamic_workflow` reliably.
- Command template forces the tool call ("You MUST call the `dynamic_workflow` tool").
- New `formatError` helper catches and formats tool errors so the user sees the cause.
- Added tests covering: edit serialization, parallel read-only workers, follow-up propagation, abort signal, and an end-to-end run via a fake OpenCode client.

## 0.1.2

- npm `postinstall` script copies `agents/*.md` and `commands/workflow.md` into `~/.config/opencode/{agents,commands}/` automatically.
- Script resolves the package root from `INIT_CWD` so it works whether invoked by npm or directly.

## 0.1.1

- First npm release.

## 0.1.0

- Initial scaffold.
# Changelog

## 0.2.0 (continued: Claude Code-aligned defaults)

- **Concurrency default now matches Claude Code**: `min(16, cpu cores - 2)` instead of a flat `8`. Excess `agent()` calls still queue on the semaphore, so behavior is unchanged apart from the slot count.
- **Child agents now run on the model the user selected.** `SessionRunner` gained `resolveParentModel()`; the SDK runner walks the parent session's messages back to the most recent assistant turn and derives `provider/model-id` from it, memoized per run (negative results included) and falling back silently if the API errors. Both tools use it beneath their explicit overrides, so a workflow follows the model picked in the TUI — including a mid-session switch — instead of the config-level default. Precedence: per-call `agent(…, { model })` → `meta.phases[].model` → tool `model` argument → plugin config `model` → parent session model → OpenCode default.
- **Packaged agents no longer pin a model.** `workflow-planner`, `workflow-reviewer`, and `workflow-worker` hardcoded `anthropic/claude-haiku-4-5` / `anthropic/claude-sonnet-4-5` in their frontmatter, which forced Anthropic calls even when OpenCode was configured for another provider — contradicting the plugin's "works with any model provider" premise, and overriding the user's own model choice.
- **New `tests/defaults.test.ts`** (6 tests) and **`tests/parent-model.test.ts`** (6 tests) pin the defaults and the model-resolution behavior so they can't silently drift.

## 0.2.0 (continued: install fixes)

- **Fixed: the plugin could not load from npm at all.** `package.json` declared an `exports` map with only `"."` and no `main`. OpenCode resolves a plugin entrypoint by checking `exports["./server"]` and falling back to `package.json.main`, and skips packages that have an `exports` map with neither — so `"plugin": ["open-workflows"]` silently did nothing. Added `main` plus an `"./server"` subpath, both pointing at a new `dist/server.js`.
- **New dedicated server entry** (`src/server.ts`): default-exports the v2 `PluginModule` record `{ id, server }` and exports nothing else. OpenCode's legacy loader path invokes every exported *function* of a plugin entry as a plugin factory, so pointing it at `dist/index.js` (the library entry, which also exports `runWorkflow`, `createSdkRunner`, …) made it call those helpers as plugins. Local-development config entries should now use `dist/server.js`.
- **Declared `zod`** as a runtime dependency. `src/tool.ts` imports it directly; it previously resolved only by npm hoisting it out of `@opencode-ai/plugin`.
- **Added `engines.opencode: ">=1.14.0"`** so an incompatible OpenCode skips the plugin with a clear message.
- **Fixed `scripts/install-assets.js`** resolving its source directory from `INIT_CWD`/`cwd`, i.e. the *consumer's* tree rather than the package. It copied nothing on a real install, and when the consumer happened to have `agents/` or `commands/` directories it copied *those* files into the user's global OpenCode config. It now resolves from the script's own location, and warns instead of exiting silently.
- **New `tests/packaging.test.ts`** (9 tests) pins the entrypoint contract: `./server` export, `main` fallback, single-export server module, declared runtime deps, `prepack` build, shipped asset directories.
- **Docs**: `npm install -g open-workflows` removed from README and INSTALL.md — OpenCode never consults the global npm root; it installs plugins itself into `~/.cache/opencode/packages/<spec>/node_modules/`. Install is now one pinned config line. Documented why pinning matters: the package cache is keyed on the literal spec string and short-circuits, so a bare name freezes on whatever was latest at first run.

## 0.2.0 (continued: parity closers)

- **Resume**: runs journal every `agent()` call to `.opencode/workflow-runs/<runId>.jsonl`; the `workflow` tool accepts `resumeFromRunId` and replays the longest unchanged (seq, hash) prefix from cache without spawning sessions. Cached replays skip the token budget but still count toward the lifetime cap and fire progress events. Hashes ignore no-op option changes (`label`, `effort`, non-worktree `isolation`, key order).
- **Nested `workflow(nameOrRef, args?)`**: saved workflows resolve from `.opencode/workflows/` (project) then `~/.config/opencode/workflows/` (global); `{scriptPath}` runs a file. One nesting level; the child shares the parent's semaphore, lifetime cap, token budget, abort signal, and journal.
- **Worktree isolation**: `agent(prompt, { isolation: 'worktree' })` runs the child session in a fresh detached-HEAD git worktree; removed when clean, preserved (path logged and appended to the result) when the agent left changes; graceful fallback outside git repos.
- **Deterministic builtins**: `Date.now()`, argless `new Date()`, `Date()` as a function, and `Math.random()` throw inside scripts with pass-it-via-`args` hints, mirroring Claude Code's resume-safety rules. `new Date(value)` and the rest of `Math`/`Date` behave identically.
- **Full-fat schema validation**: `const`, `oneOf`/`anyOf`/`allOf`, `pattern`, `minLength`/`maxLength`, `minimum`/`maximum`/exclusive bounds, `minItems`/`maxItems`, `additionalProperties` (false or schema), and nullable type arrays — all with path-prefixed error messages.
- **Phase model inheritance**: agents resolve their model as call override → `meta.phases[].model` → workflow default.
- 66 more tests (168 total across 19 files).

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
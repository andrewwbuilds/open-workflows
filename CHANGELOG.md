# Changelog

## 0.2.0 (continued: only the host now differs from Claude Code)

- **`agentType` resolves Claude Code's registry names.** `general-purpose` and `claude` map to OpenCode's `general`, `Explore` to `explore`, `Plan` to `plan`, and the package now ships a real `code-reviewer` agent. Names with no honest equivalent (`statusline-setup`, `output-style-setup`) fail with a message saying so instead of silently running an unrelated agent. Implemented as an alias table in the engine rather than six Claude-Code-named entries in `config.agent`, which would have polluted every user's agent picker forever. A user's own agent always wins over an alias, and the resume hash records the name the script wrote, so existing journals keep replaying.
- **`$ref`/`$defs` schemas are supported** instead of aborting the run. Internal pointers against `$defs`, `definitions`, and arbitrary paths, `#` as a self-reference, RFC 6901 `~0`/`~1` unescaping, and keywords sitting alongside a `$ref`. External refs are rejected up front with a clear message.
- **FIXED: legitimate deep recursion was reported as a `$ref` cycle.** The cycle backstop counted `$ref` hops and value levels on one counter, and each value level costs several schema steps, so a merely deep value tripped a 256 ceiling meant only for non-consuming cycles. Cycles are now detected precisely — a `$ref` landing on a subschema already being evaluated *for the same value* — and the depth counter is just a stack-overflow guard at 1000. A 200-deep value validates; a 5000-deep one returns a clean schema error rather than an uncatchable `RangeError`.
- **Limit breaches inside `parallel()`/`pipeline()` degrade to `null`**, matching the contract's "a thunk that throws resolves to null; the call never rejects". Outside a fan-out they still throw. The breach is logged once and surfaced on the result, so a fan-out with holes in it is never silent.
- **Resume tolerates changed `args`.** It used to refuse the whole journal; now it replays the longest unchanged prefix and goes live from the first call the new args actually altered. Same script + same args is a 100% cache hit.
- **`budget.spent()` matches Claude Code's per-turn pool**, seeded from the output tokens already spent in the enclosing turn instead of starting at 0. It is a lower bound — tokens the parent spends after the workflow starts aren't visible.
- README differences table cut from ten rows to four, all of them host limitations: the model, `isolation: 'remote'`, the progress UI, and subagent failure status.

## 0.2.0 (continued: subagent viewer, structured output, two critical fixes)

- **FIXED (critical): `agent()` returned `""` for every non-schema call against a real server.** `collectText` scanned backwards for the last non-text part to skip mid-turn narration, but every OpenCode assistant message ends with a `step-finish` part — verified 177/177 on a live server — so the scan always stopped there and returned nothing. The whole suite missed it because every fixture omitted the trailing `step-finish`. Trailing *step markers* are now walked off before the boundary scan, while a turn ending on a genuine tool call still yields `""`. Regression tests now use the real part shape.
- **FIXED (high): a `StructuredOutputError` was treated as a terminal failure.** When a model answers in prose instead of calling the forced StructuredOutput tool, OpenCode reports the error *and still returns the prose* — which the prompt instruction has usually already made valid JSON. The engine bailed before parsing, discarding the answer and never spending a single one of its `schemaRetries`. It is now handled as a schema miss: the text is scraped and the retry loop runs.
- **Subagent viewer.** New TUI plugin (`src/tui.ts`) adding a **View workflow subagents** palette command that lists the current session's child sessions newest-first with live status and opens the one you pick. OpenCode's built-in "View subagents" panel is unreachable from a plugin — it is fed only by `task` tool parts carrying a session id, and the one route that produces them queues behind the very turn the workflow runs inside, so it would deadlock. The full reasoning is in `src/tui.ts`.
- **Install now covers both halves.** OpenCode loads server plugins from `opencode.json` and TUI plugins from `tui.json`, with no `main` fallback for the latter. The documented install listed the package only in `opencode.json`, which loaded the tools and silently left users with no viewer. `opencode plugin <spec> --global` writes both; the manual path documents both files. The local-dev spec now points at the package directory, since a `.js` spec resolves to that file for both plugin kinds and fails on the TUI side.
- **FIXED: the palette command was registered with the wrong shape.** `registerLayer` was given `{description, onSelect}` where the host contract is `{name, title, desc, namespace, run}`, so the entry landed outside the `palette` namespace and dispatch called a `run` that did not exist. It worked only via the deprecated `api.command.register` fallback. `api.keymap` is typed `any` (`@opentui/keymap` isn't a dependency, `skipLibCheck` is on), and the test fake mirrored the same wrong shape, so neither the compiler nor the suite could catch it. Both fixed.
- **FIXED: the viewer could clobber other dialogs.** `refresh` re-rendered via `dialog.replace` whenever any dialog was open; it now tracks its own dialog depth.
- **Honest subagent status.** `SessionStatus` is only `idle | busy | retry` and a never-run session has no entry, so the previous mapping reported both a queued subagent and a failed one as `done`. Now `running` / `retrying` / `queued` / `idle`, with the missing error state documented.
- **Removed dead `setSessionTitle`** — declared on `SessionRunner`, implemented twice, called nowhere; phase already reaches the title at session creation.
- `tests/packaging.test.ts` now asserts the `./tui` export, whose loss would silently remove the viewer.
- README differences table corrected: it previously claimed everything but four host-level items was closed, which was wrong on `parallel()` reject semantics, `$ref` schemas, args-sensitive resume, and schema-failure nulls.

## 0.2.0 (continued: Claude Code parity gaps closed)

- **`effort` is now real.** It was declared in `AgentCallOptions` and silently ignored. OpenCode does have a per-request reasoning mechanism — model **variants** — and the prompt endpoint accepts and validates a `variant` field. `agent(prompt, { effort })` now validates eagerly against `low|medium|high|xhigh|max`, resolves the level against the target model's actual variant list from `/config/providers`, downgrades to the nearest available level with a `log()` when the model doesn't expose the requested one, and sends it as `variant`. An unknown value throws. `effort` is consequently now significant to the resume hash, since it changes what runs.
- **Script sandbox replaced.** Scripts previously ran via `new AsyncFunction(...)`, which evaluates in module scope and left ambient Node globals reachable — a script returning `process.platform` yielded `"darwin"`, against Claude Code's documented "no filesystem or Node.js API access". New `src/script/sandbox.ts` runs scripts in a `node:vm` realm built from a null-prototype global. Only primitives cross the boundary (structured data as JSON), since a single host object would expose the host realm via `value.constructor.constructor`. Verified against constructor-chain escapes: `Function`, `eval`, arrow/async-function/Promise/Array/Object constructor chains, thrown host errors, and bridge return values all resolve in a realm where `process` is `undefined`. It is a guardrail, not a security boundary — `node:vm` is explicitly not one.
- **Unknown `isolation` values throw** instead of silently running the agent unisolated in the user's working directory. `'remote'` gets a message naming why OpenCode can't support it; typos like `'worktre'` are caught too.
- **`budget.spent()` scope documented rather than faked.** Seeding from the parent session was considered and rejected: a whole-session sum is further from Claude Code's per-turn figure than 0 is, and a turn-scoped sum would make `remaining()` depend on live conversation state, breaking resume determinism. The exact scope and its four exclusions are now stated in the engine, the tool description, and the README.
- **New `README.md` "Differences from Claude Code"** table — the five remaining differences, with which are fundamental to the host.
- Test suite grew from 189 to 263 across 24 files, including `tests/sandbox.test.ts` and `tests/agent-options.test.ts`.

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
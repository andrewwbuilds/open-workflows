# open-workflows

![open-workflows swarm](docs/open-workflows.png)

[![npm version](https://img.shields.io/npm/v/open-workflows.svg)](https://www.npmjs.com/package/open-workflows)
[![license](https://img.shields.io/npm/l/open-workflows.svg)](LICENSE)

OpenCode plugin for Claude Code-style dynamic workflows: a script-driven `workflow` tool that mirrors Claude Code's Workflow API (`agent()`, `parallel()`, `pipeline()`, `phase()`, `log()`, `args`, `budget`), plus a `dynamic_workflow` planner/worker/reviewer loop. Built on OpenCode's plugin + SDK surface, so it works with any model provider and runs in your existing OpenCode setup.

You describe a goal (or hand the model an orchestration script); the plugin spins up child agents, runs them in parallel where it's safe, and streams a live roadmap of phases and running agents into the TUI while it works.

## Why

Some tasks are too big for a single agent pass: explore unfamiliar code, then edit, then verify. This plugin gives you a coordinated loop instead of one monolithic prompt.

- Read-only research runs in parallel across multiple workers.
- Editing workers always run one at a time, in dependency order.
- A reviewer decides whether to loop again, ship, or stop and ask the user.
- Every child session is a real OpenCode session, so you can navigate to it with `Leader+Down` and inspect what each agent did.

Modeled on Anthropic's [dynamic workflows in Claude Code](https://docs.claude.com/en/docs/claude-code/dynamic-workflows), ported onto OpenCode so it works with any model and any project you point OpenCode at. Two things sit under one plugin:

- **`workflow`** — the port of the real thing. You (or the model) write a deterministic orchestration script and the engine executes it: `agent()` with JSON-Schema-validated output and retries, `parallel()`, `pipeline()`, `phase()`, `log()`, `args`, `budget`, nested `workflow()`, optional git-worktree isolation, and journal-based resume.
- **`dynamic_workflow`** — a prebuilt planner/worker/reviewer loop for when you'd rather describe a goal than write a script. This one has no Claude Code counterpart; control flow comes from an LLM planner rather than a script.

Reach for `workflow` when you know the shape of the work, and `dynamic_workflow` when you don't.

## Install

### From npm (recommended)

One line in your OpenCode config — there is no `npm install` step. OpenCode installs the plugin itself into `~/.cache/opencode/packages/<spec>/node_modules/`.

`~/.config/opencode/opencode.jsonc` (don't remove your other settings):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["open-workflows@0.2.0"]
}
```

**Pin the version.** A bare `"open-workflows"` resolves to `open-workflows@latest` exactly once, and OpenCode's package cache is keyed on the literal spec string and short-circuits on every later start — so an unpinned entry freezes on whatever was latest the first time you ran it, with no upgrade path except deleting the cache directory by hand. Bump the pin to upgrade.

**This package has two halves, and OpenCode loads them from different configs.** The tools are a *server* plugin (`opencode.jsonc` → `plugin[]`); the subagent viewer is a *TUI* plugin (`tui.json` → `plugin[]`). `opencode.jsonc` never feeds the TUI loader, so listing the package only there gives you working tools and no viewer. The one command that wires up both:

```bash
opencode plugin open-workflows@0.2.0 --global
```

Restart OpenCode. The plugin registers the `workflow` and `dynamic_workflow` tools, the `workflow-planner` / `workflow-worker` / `workflow-reviewer` agents, and the `/workflow` command in-process through the plugin `config` hook — no files are copied into your config directory.

Verify it's loaded by starting a session and typing `/workflow` (the command should autocomplete), or by asking the model to use `dynamic_workflow`.

### Watching subagents

Every `agent()` call creates a real OpenCode child session of the session you're in, titled `<phase> · <label>`. Two ways to watch them:

- **View workflow subagents** in the command palette — lists this session's child sessions newest-first with a live status, and opens the one you pick. Needs the TUI half installed (above).
- The workflow's tool block streams a live roadmap — current phase, running agent labels, per-phase done/failed counts — and the final result lists every child session id.

Status comes from OpenCode's `SessionStatus`, which is only `idle | busy | retry`: a subagent shows as `running`, `retrying`, `queued` (never started), or `idle` (settled). There is **no error state to read**, so a failed subagent reads `idle` like a successful one — check the workflow result for what actually failed. This is the one place the viewer is weaker than Claude Code's.

This is a plugin-provided viewer, not OpenCode's built-in "View subagents" panel. That panel is fed only by tool parts named `task` carrying a session id, which only OpenCode's own task tool produces; a plugin cannot emit one, and the route that would (a `subtask` part on a user message) queues behind the very turn the workflow is running inside. See [src/tui.ts](src/tui.ts) for the full reasoning.

### From a local clone

```sh
git clone https://github.com/AndrxwWxng/open-workflows
cd open-workflows
npm install
npm run build
```

Point the loader at the **package directory**, so OpenCode can resolve both the `./server` and `./tui` entries from `package.json`:

```bash
opencode plugin file:///absolute/path/to/open-workflows --global
```

A spec naming a `.js` file resolves to that one file for both plugin kinds, so `file://.../dist/server.js` in `tui.json` tries to load the server module as a TUI plugin and fails. If you do pin a file for the server entry, use `dist/server.js`, never `dist/index.js` — `server.js` exports only the plugin module, while `index.js` is the library entry and exports `runWorkflow`, `createSdkRunner`, and friends, which OpenCode's legacy loader path would each try to invoke as a plugin factory.

Restart OpenCode after each rebuild.

### Agents and command

The packaged `workflow-planner`, `workflow-worker`, and `workflow-reviewer` agents and the `/workflow` command register automatically when the plugin loads. Anything you define yourself under the same name (in your config or `~/.config/opencode/agents/`) wins over the packaged version.

If you prefer file-based copies you can still materialize them with `npm run install-assets` from a clone, or copy `agents/*.md` and `commands/*.md` into `~/.config/opencode/{agents,commands}/` (or per-project `.opencode/{agents,commands}/`) by hand.

## Configuration

Three layers, in increasing priority:

1. **Built-in defaults** — see the table below.
2. **Plugin config** — a tuple alongside the package name. Sets your personal baseline for every workflow run.
3. **Tool arguments** — passed to `dynamic_workflow` per call. Override the config for that one run.

```jsonc
{
  "plugin": [
    ["open-workflows", {
      "plannerAgent": "workflow-planner",
      "workerAgent": "workflow-worker",
      "reviewerAgent": "workflow-reviewer",
      "maxRounds": 3,
      "maxWorkers": 3,
      "maxTasks": 20,
      "allowEdits": false,
      "parallelWorkers": true
    }]
  ]
}
```

Precedence example: with the config above, calling

```text
Use dynamic_workflow with mode implement, allowEdits true, and maxRounds 5 to add password reset.
```

runs with `mode=implement`, `allowEdits=true`, `maxRounds=5`, and every other setting inherited from the config.

Per-project overrides work too — drop a `.opencode/opencode.jsonc` with its own `plugin:` tuple into the project root, and OpenCode merges it on top of the global config.

| Option | Default | Meaning |
| --- | --- | --- |
| `plannerAgent` | `plan` | Agent that decomposes the goal into tasks. |
| `workerAgent` | `general` | Default agent for workers. |
| `reviewerAgent` | `general` | Agent that decides pass / iterate / blocked. |
| `maxRounds` | `3` | Maximum planner→reviewer iterations. |
| `maxWorkers` | `3` | Workers per round (split between research and edit). |
| `maxTasks` | `20` | Tasks accepted from the planner per round. |
| `allowEdits` | `false` | Allow workers to modify files. Off by default. |
| `parallelWorkers` | `true` | Run read-only workers concurrently. Edits stay serial. |

## Usage

### Script workflows (`workflow` tool)

The `workflow` tool executes a Claude Code-compatible workflow script — the same shape as [Anthropic's Workflow tool](https://docs.claude.com/en/docs/claude-code/dynamic-workflows). The model writes the orchestration script; the plugin runs each `agent()` call as a real OpenCode child session:

```js
export const meta = {
  name: 'review-changes',
  description: 'Review changed files, verify each finding',
  phases: [{ title: 'Review' }, { title: 'Verify' }],
}
const results = await pipeline(
  ['bugs', 'perf'],
  (dim) => agent(`Review the diff for ${dim} issues.`, {
    phase: 'Review',
    schema: { type: 'object', required: ['findings'] },
  }),
  (review) => parallel((review?.findings ?? []).map((f) => () =>
    agent(`Adversarially verify: ${f.title}`, { phase: 'Verify' })
  )),
)
return results.flat().filter(Boolean)
```

Inside the script body (async context, plain JavaScript):

- `agent(prompt, opts?)` — spawn a child session. `opts`: `label`, `phase`, `schema` (JSON Schema; response is parsed, validated, and retried in-session on mismatch), `model` (`provider/model-id`), `agentType` (OpenCode agent name), `effort`, `isolation`. Returns the agent's text, the validated object, or `null` on failure. Agents inherit their phase's `model` from `meta.phases` when the call has no override.
  - `effort: 'low'|'medium'|'high'|'xhigh'|'max'` sets that call's reasoning budget. It maps onto OpenCode's model **variants**, which is the same mechanism the TUI's variant picker drives. If the target model doesn't expose the requested level, the engine downgrades to the nearest one it does and `log()`s the substitution, so an effort can never silently do nothing. Any other value throws.
  - `isolation: 'worktree'` runs the agent in a fresh git worktree so parallel file-mutating agents can't conflict; auto-removed when unchanged, preserved and reported when the agent left changes. It is the only supported value — Claude Code's `'remote'` needs a cloud sandbox OpenCode doesn't have, so it throws rather than silently running the agent unisolated in your working directory.
- `parallel(thunks)` — run concurrently with a barrier; a throwing thunk resolves to `null`.
- `pipeline(items, ...stages)` — each item flows through all stages independently, no barrier between stages; stage callbacks receive `(prev, originalItem, index)`.
- `phase(title)` / `log(message)` — drive the live roadmap in the TUI.
- `args` — the tool's `args` input, verbatim.
- `budget` — `{ total, spent(), remaining() }` in output tokens when `budgetTokens` is set; the ceiling is hard (further `agent()` calls throw, and inside `parallel()`/`pipeline()` that throw becomes a `null` item). `spent()` is seeded from the output tokens already spent in the enclosing turn and adds the child sessions this workflow and its nested `workflow()` children spawn, matching Claude Code's per-turn shared pool.
- `workflow(nameOrRef, args?)` — run another workflow inline (one nesting level). Pass a name to run a saved workflow from `.opencode/workflows/<name>.js` (project) or `~/.config/opencode/workflows/<name>.js` (global), or `{scriptPath}` for a script file. The child shares the parent's concurrency, lifetime cap, token budget, and abort signal.

Schema validation covers `type` (including arrays like `["string","null"]`), `properties`/`required`/`items`, `enum`/`const`, `oneOf`/`anyOf`/`allOf`/`not`, `if`/`then`/`else`, `pattern`, string/number/array bounds, `additionalProperties`, and internal `$ref` against `$defs`/`definitions` — including recursive schemas. External refs (anything not starting with `#`) are rejected up front, since the validator does not fetch documents.

`Date.now()`, argless `new Date()`, and `Math.random()` throw inside scripts (pass timestamps/seeds via `args`) so runs stay deterministic for resume.

Scripts run in a dedicated `node:vm` realm built from a null-prototype global, matching Claude Code's "no filesystem or Node.js API access". `process`, `require`, `fetch`, `Buffer`, timers, `__dirname`, and dynamic `import()` are all unreachable, and `globalThis` holds only the workflow globals plus the standard ECMAScript built-ins. Every value crossing the boundary is a primitive — structured data travels as JSON — because handing script code a single host object would expose the host realm through `value.constructor.constructor`. Treat this as a guardrail against a misbehaving or model-authored script, **not** a security boundary: `node:vm` is explicitly not one, and this doesn't sandbox the *agents* a script spawns, which run with whatever permissions their OpenCode agent grants.

**Resume**: every run journals its `agent()` calls to `.opencode/workflow-runs/<runId>.jsonl` and reports its `runId`. Pass `resumeFromRunId` to replay the longest unchanged prefix of `agent()` calls from cache — only edited or new calls run live. Cached replays don't count against the token budget.

Concurrency is capped per workflow at `min(16, cpu cores - 2)` — the same default Claude Code uses. Excess `agent()` calls queue and run as slots free up, so a 100-item `parallel()`/`pipeline()` still completes; only the cap's worth run at any moment. A 1000-agent lifetime cap and a 4096-item per-call limit back it up.

## Differences from Claude Code

A script written against Claude Code's Workflow API runs here unchanged. The primitives, defaults, caps, schema validation (including `$ref`/`$defs`), determinism rules, sandbox guarantees, error semantics, and resume behavior all match. Four things genuinely differ, and all four are the host, not the port:

| | Claude Code | here |
| --- | --- | --- |
| **Model** | Claude models | whichever model your OpenCode session is on — the point of the port |
| `isolation: 'remote'` | runs the agent in a remote cloud environment | throws with a message naming why; OpenCode has no cloud sandbox. `'worktree'` works |
| Progress UI | the `/workflows` view | a live roadmap in the tool block, plus a **View workflow subagents** palette command |
| Subagent status | per-agent running/done/**failed** | OpenCode's `SessionStatus` is only `idle\|busy\|retry`, so the viewer cannot show that a subagent failed — check the workflow result |

`agentType` now resolves Claude Code's registry names: `general-purpose` and `claude` map to OpenCode's `general`, `Explore` to `explore`, `Plan` to `plan`, and this package ships a real `code-reviewer` agent. A name with no honest equivalent (`statusline-setup`, `output-style-setup`) fails with a message saying so rather than silently running some other agent. Your own agent always wins over an alias, and the resume hash records the name the script wrote, so existing journals keep replaying.

`budget.spent()` is seeded from the output tokens already spent in the enclosing turn, so it reports Claude Code's per-turn pool rather than this run in isolation. It is a lower bound: OpenCode commits the parent's token counts as the turn progresses, so tokens spent after the workflow starts aren't visible to it.

## How a round runs

1. The planner produces a small set of tasks with kinds, dependencies, and acceptance criteria.
2. Workers run in parallel when they have no dependencies and aren't editing. Edit tasks always run one at a time in declaration order.
3. The reviewer reads the worker reports, marks each success criterion met or missed, and replies with `pass`, `needs-attention`, or `blocked`.
4. On `needs-attention` the workflow starts a new round. On `pass` it stops. On `blocked` it stops and returns the reason.

Child sessions stay attached to the parent, so the TUI's session tree shows the swarm.

## Safety

- Editing is disabled by default. Enable it explicitly with `allowEdits: true`.
- Parallel editing is never on; editing workers are always serial.
- Worker prompts tell agents not to commit, push, reset, or delete unrelated files.
- The reviewer and worker prompts deny the `task` tool, so child agents cannot spawn additional subagents.
- Round, worker, and task counts are hard-capped so a runaway planner cannot exhaust your budget.

## Development

```sh
npm install
npm run typecheck
npm test
npm run lint
npm run build
```

The package exports an ESM plugin from `dist/index.js`. OpenCode's npm plugin loader installs it into `~/.cache/opencode/node_modules/` automatically.

## License

MIT
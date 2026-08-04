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

Restart OpenCode. That's the whole install: the plugin registers the `workflow` and `dynamic_workflow` tools, the `workflow-planner` / `workflow-worker` / `workflow-reviewer` agents, and the `/workflow` command in-process through the plugin `config` hook — no files are copied into your config directory.

Verify it's loaded by starting a session and typing `/workflow` (the command should autocomplete), or by asking the model to use `dynamic_workflow`.

### From a local clone

```sh
git clone https://github.com/AndrxwWxng/open-workflows
cd open-workflows
npm install
npm run build
```

Point the plugin loader at the local build:

```jsonc
{
  "plugin": ["file:///absolute/path/to/open-workflows/dist/server.js"]
}
```

Use `dist/server.js`, not `dist/index.js`. `server.js` exports only the plugin module; `index.js` is the library entry and exports `runWorkflow`, `createSdkRunner`, and friends, which OpenCode's legacy loader path would each try to invoke as a plugin factory.

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

- `agent(prompt, opts?)` — spawn a child session. `opts`: `label`, `phase`, `schema` (JSON Schema; response is parsed, validated, and retried in-session on mismatch), `model` (`provider/model-id`), `agentType` (OpenCode agent name), `isolation: 'worktree'` (runs the agent in a fresh git worktree so parallel file-mutating agents can't conflict; auto-removed when unchanged, preserved and reported when the agent left changes). Returns the agent's text, the validated object, or `null` on failure. Agents inherit their phase's `model` from `meta.phases` when the call has no override.
- `parallel(thunks)` — run concurrently with a barrier; a throwing thunk resolves to `null`.
- `pipeline(items, ...stages)` — each item flows through all stages independently, no barrier between stages; stage callbacks receive `(prev, originalItem, index)`.
- `phase(title)` / `log(message)` — drive the live roadmap in the TUI.
- `args` — the tool's `args` input, verbatim.
- `budget` — `{ total, spent(), remaining() }` in output tokens when `budgetTokens` is set; the ceiling is hard (further `agent()` calls throw).
- `workflow(nameOrRef, args?)` — run another workflow inline (one nesting level). Pass a name to run a saved workflow from `.opencode/workflows/<name>.js` (project) or `~/.config/opencode/workflows/<name>.js` (global), or `{scriptPath}` for a script file. The child shares the parent's concurrency, lifetime cap, token budget, and abort signal.

Schema validation covers `type` (including arrays like `["string","null"]`), `properties`/`required`/`items`, `enum`/`const`, `oneOf`/`anyOf`/`allOf`, `pattern`, string/number/array bounds, and `additionalProperties`.

`Date.now()`, argless `new Date()`, and `Math.random()` throw inside scripts (pass timestamps/seeds via `args`) so runs stay deterministic for resume.

**Resume**: every run journals its `agent()` calls to `.opencode/workflow-runs/<runId>.jsonl` and reports its `runId`. Pass `resumeFromRunId` to replay the longest unchanged prefix of `agent()` calls from cache — only edited or new calls run live. Cached replays don't count against the token budget.

Concurrency is capped per workflow at `min(16, cpu cores - 2)` — the same default Claude Code uses. Excess `agent()` calls queue and run as slots free up, so a 100-item `parallel()`/`pipeline()` still completes; only the cap's worth run at any moment. A 1000-agent lifetime cap and a 4096-item per-call limit back it up.

**Child agents run on the model you selected.** The plugin reads the parent session's most recent assistant turn and uses that model for child sessions, so a workflow runs on whatever you picked in the TUI — including a mid-session switch — rather than the config-level default. The packaged agents pin no provider, so this works on any provider your OpenCode is set up for.

Model precedence, highest first:

1. `agent(prompt, { model })` — one call.
2. `meta.phases[].model` — every agent in that phase.
3. The tool's `model` argument — the whole run.
4. The plugin config's `model` option.
5. **The model your session is using** — the default.
6. OpenCode's own default, if the parent session has no assistant turn yet.

While a workflow runs, the tool streams a roadmap through its metadata — the OpenCode TUI shows the current phase, running agent labels, and per-phase done/failed counts, updating live:

```text
[x] Review - 2 done
[>] Verify - 3 done, 2 running
      * verify: src/auth.ts
      * verify: src/session.ts
[ ] Synthesize
  log: 5 findings so far
```

### Goal workflows (`dynamic_workflow` tool)

Ask for it by name, or the model picks it up when the goal is multi-step:

```text
Use dynamic_workflow to audit the auth flow in this repo. Mode research, maxRounds 2.
```

For an implementation loop:

```text
Use dynamic_workflow with mode implement and allowEdits true to add password reset.
Run the test suite as the last worker task. Do not commit or push.
```

Tool arguments:

- `goal` (required): the objective.
- `mode`: `research`, `implement`, or `review`. Defaults to `research`.
- `allowEdits`: set `true` for implementation work.
- `maxRounds`, `maxWorkers`, `maxTasks`: same as the config options, per-call.
- `parallelWorkers`: turn off to force sequential workers.
- `successCriteria`: list of strings the reviewer checks against.
- `plannerAgent`, `workerAgent`, `reviewerAgent`: override the configured defaults.
- `model`: optional `provider/model-id` (e.g. `anthropic/claude-sonnet-4-5`).

### As a command

The `/workflow` command registers automatically with the plugin. Trigger a workflow from the prompt with:

```text
/workflow audit the auth flow in this repo
/workflow implement password reset, allowEdits, run tests at the end
```

The command invokes `dynamic_workflow` with sensible defaults and the rest of your text as the goal.

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
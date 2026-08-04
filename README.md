# open-workflows

![open-workflows swarm](docs/open-workflows.png)

[![npm version](https://img.shields.io/npm/v/open-workflows.svg)](https://www.npmjs.com/package/open-workflows)
[![license](https://img.shields.io/npm/l/open-workflows.svg)](LICENSE)

OpenCode plugin for Claude Code-style dynamic workflows: a script-driven `workflow` tool (1:1 with Claude Code's Workflow API — `agent()`, `parallel()`, `pipeline()`, `phase()`, `log()`, `args`, `budget`) plus a `dynamic_workflow` planner/worker/reviewer loop. Built on OpenCode's plugin + SDK surface, so it works with any model provider and runs in your existing OpenCode setup.

You describe a goal (or hand the model an orchestration script); the plugin spins up child agents, runs them in parallel where it's safe, and streams a live roadmap of phases and running agents into the TUI while it works.

## Why

Some tasks are too big for a single agent pass: explore unfamiliar code, then edit, then verify. This plugin gives you a coordinated loop instead of one monolithic prompt.

- Read-only research runs in parallel across multiple workers.
- Editing workers always run one at a time, in dependency order.
- A reviewer decides whether to loop again, ship, or stop and ask the user.
- Every child session is a real OpenCode session, so you can navigate to it with `Leader+Down` and inspect what each agent did.

Inspired by Anthropic's [dynamic workflows in Claude Code](https://docs.claude.com/en/docs/claude-code/dynamic-workflows): same planner/worker/reviewer shape, ported onto OpenCode so it works with any model and any project you point OpenCode at.

## Install

### From npm (recommended)

```sh
npm install -g open-workflows
```

Add it to your OpenCode config (don't remove your other settings):

`~/.config/opencode/opencode.jsonc`

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["open-workflows"]
}
```

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
  "plugin": ["file:///absolute/path/to/open-workflows/dist/index.js"]
}
```

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

- `agent(prompt, opts?)` — spawn a child session. `opts`: `label`, `phase`, `schema` (JSON Schema; response is parsed, validated, and retried in-session on mismatch), `model` (`provider/model-id`), `agentType` (OpenCode agent name). Returns the agent's text, the validated object, or `null` on failure.
- `parallel(thunks)` — run concurrently with a barrier; a throwing thunk resolves to `null`.
- `pipeline(items, ...stages)` — each item flows through all stages independently, no barrier between stages; stage callbacks receive `(prev, originalItem, index)`.
- `phase(title)` / `log(message)` — drive the live roadmap in the TUI.
- `args` — the tool's `args` input, verbatim.
- `budget` — `{ total, spent(), remaining() }` in output tokens when `budgetTokens` is set; the ceiling is hard (further `agent()` calls throw).

Concurrency is capped per workflow (default 8; excess `agent()` calls queue), with a 1000-agent lifetime cap and 4096 items per `parallel()`/`pipeline()` call.

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
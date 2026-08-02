# OpenCode Dynamic Workflows

A global OpenCode plugin that coordinates planner, worker, and reviewer agents with bounded loops.

## What it does

The `dynamic_workflow` tool turns a goal into a controlled workflow:

1. A planning agent decomposes the goal into tasks.
2. Worker agents execute or research those tasks.
3. A reviewer checks the work and proposes follow-up tasks.
4. The workflow repeats until the reviewer passes, the budget is exhausted, or a failure policy stops it.

Child sessions remain visible in OpenCode so the work can be inspected individually.

## Install globally

After this package is published, add it to `~/.config/opencode/opencode.jsonc` without removing your existing settings:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-dynamic-workflows"]
}
```

Restart OpenCode after changing plugin configuration.

For local development, build the package and point the global config at the generated module:

```jsonc
{
  "plugin": [
    "file:///absolute/path/to/opencode-dynamic-workflows/dist/index.js"
  ]
}
```

## Use it

Ask OpenCode to use `dynamic_workflow`, or describe the workflow explicitly:

```text
Use dynamic_workflow to implement account recovery. Have workers inspect the existing auth flow, database schema, and UI, then run tests and iterate until the reviewer passes.
```

Important arguments:

- `goal`: The objective to coordinate.
- `mode`: `implement`, `research`, or `review`.
- `allowEdits`: Allows workers to modify the worktree. It defaults to `false`.
- `maxRounds`: Maximum planner-reviewer loop count.
- `maxWorkers`: Maximum workers per round.
- `parallelWorkers`: Runs read-only workers concurrently. Editing workers are forced to run serially.
- `successCriteria`: Optional explicit verification criteria.
- `plannerAgent`, `workerAgent`, `reviewerAgent`: OpenCode agent names.
- `model`: Optional `provider/model-id` override for child sessions.

Example implementation request:

```text
Use dynamic_workflow with mode implement, allowEdits true, and maxRounds 3 to add password reset. Do not commit or push anything.
```

## Configuration options

Plugin defaults can be set in the config tuple:

```jsonc
{
  "plugin": [
    ["opencode-dynamic-workflows", {
      "plannerAgent": "plan",
      "workerAgent": "general",
      "reviewerAgent": "general",
      "maxRounds": 3,
      "maxWorkers": 3,
      "maxTasks": 20,
      "allowEdits": false,
      "parallelWorkers": true
    }]
  ]
}
```

Tool arguments override plugin defaults.

## Safety model

- Editing is disabled by default.
- Parallel editing is never enabled; editing workers run one at a time.
- Child agents cannot launch additional subagents through the built-in task tool.
- Child agents are instructed not to commit, push, reset, or remove unrelated files.
- Every loop has explicit round, worker, and task limits.

## Development

```sh
npm install
npm run typecheck
npm test
npm run lint
npm run build
```

The package is designed for OpenCode's npm plugin loader and exports an ESM plugin from `dist/index.js`.

## License

MIT

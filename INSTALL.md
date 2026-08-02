# Install

## npm

```sh
npm install -g open-workflows
```

Add the plugin to your OpenCode config (don't remove your other settings):

`~/.config/opencode/opencode.jsonc`

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["open-workflows"]
}
```

With options:

```jsonc
{
  "plugin": [
    ["open-workflows", {
      "plannerAgent": "workflow-planner",
      "workerAgent": "workflow-worker",
      "reviewerAgent": "workflow-reviewer",
      "maxRounds": 3,
      "allowEdits": false
    }]
  ]
}
```

Quit and restart OpenCode after changing plugin configuration.

## Local development

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

## Optional agents and command

The package ships with three agent definitions (`workflow-planner.md`, `workflow-worker.md`, `workflow-reviewer.md`) and a `/workflow` command shortcut (`commands/workflow.md`).

Install both globally:

```sh
mkdir -p ~/.config/opencode/agents
mkdir -p ~/.config/opencode/commands
cp agents/*.md ~/.config/opencode/agents/
cp commands/*.md ~/.config/opencode/commands/
```

Or per-project into `.opencode/agents/` and `.opencode/commands/`. Then reference them by name from the plugin config or the `dynamic_workflow` tool arguments.

The `/workflow` command is a thin wrapper that calls the `dynamic_workflow` tool with sensible defaults. Use it when you want a single-shot invocation without writing a sentence: `/workflow audit the auth flow`.
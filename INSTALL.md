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
git clone https://github.com/anomalyco/open-workflows
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

## Optional agents

The included agent definitions in `agents/` (`workflow-planner.md`, `workflow-worker.md`, `workflow-reviewer.md`) ship with the package. To install them globally, copy them into `~/.config/opencode/agents/`:

```sh
mkdir -p ~/.config/opencode/agents
cp agents/*.md ~/.config/opencode/agents/
```

Or per-project into `.opencode/agents/`. Then reference them by name from the plugin config or from the `dynamic_workflow` tool arguments.
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

## Agents and command

The three agent definitions (`workflow-planner`, `workflow-worker`, `workflow-reviewer`) and the `/workflow` command register automatically through the plugin `config` hook when OpenCode loads the plugin — nothing is copied into your config directory. Agents or commands you define yourself under the same names take precedence.

To materialize file-based copies anyway (for editing or per-project overrides), run `npm run install-assets` from a clone, or copy `agents/*.md` / `commands/*.md` into `~/.config/opencode/{agents,commands}/` or per-project `.opencode/{agents,commands}/`.

The `/workflow` command is a thin wrapper that calls the `dynamic_workflow` tool with sensible defaults. Use it when you want a single-shot invocation without writing a sentence: `/workflow audit the auth flow`.
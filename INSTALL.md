# Install

## npm (recommended)

There is no `npm install` step. OpenCode installs plugins itself, into
`~/.cache/opencode/packages/<spec>/node_modules/`. The global npm root is never
consulted by the plugin loader, so `npm install -g open-workflows` does nothing
for plugin resolution.

Add one entry to your OpenCode config (don't remove your other settings):

`~/.config/opencode/opencode.jsonc`

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["open-workflows@0.2.0"]
}
```

With options:

```jsonc
{
  "plugin": [
    ["open-workflows@0.2.0", {
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

### Pin the version

OpenCode's package cache is keyed on the literal spec string and short-circuits
once that directory exists. A bare `"open-workflows"` is rewritten to
`open-workflows@latest`, resolved once, and then frozen — later starts reuse
`~/.cache/opencode/packages/open-workflows@latest/` without re-resolving.

Pin the version, and bump the pin to upgrade. To force a re-resolve of an
unpinned entry, delete its cache directory:

```sh
rm -rf ~/.cache/opencode/packages/open-workflows@latest
```

### Verify it loaded

Start OpenCode in any project and type `/workflow` at the prompt — the command
should autocomplete. Or ask the model to use `workflow` or `dynamic_workflow`;
both tools should be available.

If nothing shows up, check the OpenCode log for `plugin has no server
entrypoint` or a plugin load error.

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
  "plugin": ["file:///absolute/path/to/open-workflows/dist/server.js"]
}
```

Use `dist/server.js`, not `dist/index.js`. The server entry exports only the
plugin module. `index.js` is the library entry and also exports `runWorkflow`,
`createSdkRunner`, `formatWorkflowResult` and friends — OpenCode's legacy loader
path invokes every exported function of a plugin entry as a plugin factory, so
pointing it at `index.js` makes it call those helpers as if they were plugins.

Restart OpenCode after each rebuild.

## Agents and command

The three agent definitions (`workflow-planner`, `workflow-worker`,
`workflow-reviewer`) and the `/workflow` command register automatically through
the plugin `config` hook when OpenCode loads the plugin — nothing is copied into
your config directory.

Anything you define yourself under the same name wins: a
`~/.config/opencode/agents/workflow-planner.md`, or an `agent.workflow-planner`
entry in your config, overrides the packaged version field by field — set just
`model` and you keep the packaged prompt and permissions.

To materialize file-based copies anyway (for editing or per-project overrides),
run `npm run install-assets` from a clone, or copy `agents/*.md` and
`commands/*.md` into `~/.config/opencode/{agents,commands}/` or per-project
`.opencode/{agents,commands}/`. Current OpenCode reads both spellings
(`{agent,agents}/**/*.md`, `{command,commands}/**/*.md`); older releases were
singular-only.

`install-assets` is a manual escape hatch, not part of installation. It is
deliberately not wired to `postinstall`: OpenCode installs plugins with npm
lifecycle scripts disabled, so a `postinstall` can never run on the path that
actually installs this plugin.

The `/workflow` command is a thin wrapper that calls the `dynamic_workflow` tool
with sensible defaults. Use it when you want a single-shot invocation without
writing a sentence: `/workflow audit the auth flow`.

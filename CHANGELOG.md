# Changelog

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
# open-workflows

OpenCode plugin that ports Claude Code's dynamic-workflow model to OpenCode: a script-driven `workflow` tool (`agent()`, `parallel()`, `pipeline()`, `phase()`, journal-based resume) plus a `dynamic_workflow` planner/worker/reviewer loop. Works with any model provider through OpenCode's plugin + SDK surface.

## Repo layout

- `src/plugin.ts`, `src/index.ts` — plugin entry points and registration.
- `src/orchestrator.ts` — runs agents, handles parallel/pipeline/phase execution.
- `src/script/` — the `workflow` script engine: `engine.ts` (execution), `journal.ts` (resume), `schema.ts`, `sandbox.ts`, `agent-alias.ts`.
- `src/runtime/` — OpenCode SDK wiring (`sdk.ts`) and a fake runtime for tests (`fake.ts`).
- `src/tui.ts` — the subagent viewer (TUI half of the plugin, loaded separately from `tui.json`).
- `src/server.ts` — server-half entry (loaded from `opencode.jsonc`).
- `src/config.ts`, `src/options.ts`, `src/prompts.ts`, `src/format.ts`, `src/progress.ts` — config resolution, agent options, prompt templates, output formatting, live progress streaming.
- `src/util/` — small helpers: error formatting, id generation, arg normalization/parsing.
- `agents/` — markdown agent defs shipped with the package (`workflow-planner.md`, `workflow-worker.md`, `workflow-reviewer.md`, `code-reviewer.md`).
- `commands/commands/workflow.md` — the `/workflow` slash command definition.
- `scripts/install-assets.js` — copies `agents/` and `commands/` into an OpenCode config dir on install.
- `tests/` — vitest suite, one file per concern (orchestrator, sandbox, cancellation, resume-determinism, packaging, etc).
- `docs/` — static assets (e.g. the README screenshot).

## Commands

- Install deps: `npm install`
- Build: `npm run build` (runs `tsc`, emits to `dist/`)
- Typecheck only: `npm run typecheck`
- Lint: `npm run lint` (eslint over `src/` and `tests/`)
- Test: `npm test` (vitest run, picks up `tests/**/*.test.ts`)
- Install shipped assets into an OpenCode config dir: `npm run install-assets`

There is no local dev server — this is a plugin consumed by OpenCode, not a standalone app. To exercise it locally, build then point OpenCode's loader at the package directory (`opencode plugin file:///absolute/path/to/open-workflows --global`); see README.md for the two-config split (`opencode.jsonc` for the server half, `tui.json` for the viewer half).

## Conventions

- TypeScript, ESM (`"type": "module"`), strict-ish `tsconfig.json`.
- `@typescript-eslint/consistent-type-imports` is enforced — use `import type` for type-only imports.
- `@typescript-eslint/no-explicit-any` is off, so `any` shows up deliberately in places (runtime/SDK boundary code).
- Node >=22, targets OpenCode >=1.14.0 (see `engines` in `package.json`).
- Tests live under `tests/`, named `<concern>.test.ts`, run against vitest with a fake runtime (`src/runtime/fake.ts`) rather than a live OpenCode instance.

## Gotchas

- The package has two independently-loaded halves: the `server` export (tools, agents, `/workflow` command) goes in `opencode.jsonc` → `plugin[]`; the `tui` export (subagent viewer) goes in `tui.json` → `plugin[]`. Listing it only in one config leaves the other half missing.
- OpenCode's package cache keys on the literal plugin spec string and never re-resolves it — an unpinned `"open-workflows"` freezes on whatever was `latest` at first run. Always pin the version.
- OpenCode's `SessionStatus` has no error state (`idle | busy | retry` only), so a failed subagent in the viewer looks the same as a successful one. Check the workflow tool's result output for actual failures, not the viewer.
- The TUI viewer is plugin-provided, not OpenCode's built-in "View subagents" panel — that panel only reacts to session-id-carrying `task` parts, which a plugin can't emit.

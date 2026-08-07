/**
 * Plugin id OpenCode uses to identify this plugin in logs and dedupe.
 *
 * It lives in its own module so the TUI entry (src/tui.ts) can import it
 * without pulling in the server plugin, its tools, and zod - a TUI plugin is
 * loaded in a different process context and should not drag the tool layer in.
 */
export const PLUGIN_ID = "open-workflows"

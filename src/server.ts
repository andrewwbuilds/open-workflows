import type { PluginModule } from "@opencode-ai/plugin"
import { DynamicWorkflowPlugin, PLUGIN_ID } from "./plugin.js"

/**
 * OpenCode plugin entrypoint (`exports["./server"]` and `main`).
 *
 * This module intentionally has exactly ONE export: the default v2
 * `PluginModule` record. OpenCode's legacy loader path calls every exported
 * *function* of a plugin entry as a plugin factory, so re-exporting library
 * helpers here would make it invoke `runWorkflow`, `createDynamicWorkflowTool`,
 * etc. as if they were plugins. Library consumers import from "open-workflows"
 * (the "." subpath) instead.
 */
const serverModule: PluginModule = {
  id: PLUGIN_ID,
  server: DynamicWorkflowPlugin,
}

export default serverModule

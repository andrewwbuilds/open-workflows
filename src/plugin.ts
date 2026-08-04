import type { Plugin } from "@opencode-ai/plugin"
import { createDynamicWorkflowTool, createWorkflowScriptTool } from "./tool.js"
import { applyWorkflowConfig } from "./config.js"
import type { DynamicWorkflowOptions } from "./types.js"

/** Plugin id OpenCode uses to identify this plugin in logs and dedupe. */
export const PLUGIN_ID = "open-workflows"

export const DynamicWorkflowPlugin: Plugin = async (ctx, options) => {
  const pluginOptions = (options ?? {}) as DynamicWorkflowOptions
  const workflow = createDynamicWorkflowTool({
    client: ctx.client,
    pluginOptions,
  })
  const workflowScript = createWorkflowScriptTool({
    client: ctx.client,
    pluginOptions,
  })
  return {
    config: async (config) => {
      applyWorkflowConfig(config)
    },
    tool: {
      dynamic_workflow: workflow,
      workflow: workflowScript,
    },
  }
}

import type { Plugin } from "@opencode-ai/plugin"
import { createDynamicWorkflowTool, createWorkflowScriptTool } from "./tool.js"
import { applyWorkflowConfig } from "./config.js"
import type { DynamicWorkflowOptions } from "./types.js"

export { PLUGIN_ID } from "./plugin-id.js"

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

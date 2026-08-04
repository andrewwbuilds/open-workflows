import type { Plugin } from "@opencode-ai/plugin"
import { createDynamicWorkflowTool, createWorkflowScriptTool } from "./tool.js"
import { applyWorkflowConfig } from "./config.js"
import type { DynamicWorkflowOptions } from "./types.js"

const DynamicWorkflowPlugin: Plugin = async (ctx, options) => {
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

export default DynamicWorkflowPlugin
export { DynamicWorkflowPlugin }
export { createDynamicWorkflowTool, createWorkflowScriptTool } from "./tool.js"
export { runWorkflow } from "./orchestrator.js"
export { runWorkflowScript, WorkflowScriptError, WorkflowAbortError } from "./script/engine.js"
export { parseWorkflowScript } from "./script/meta.js"
export { WorkflowProgress } from "./progress.js"
export { applyWorkflowConfig } from "./config.js"
export { loadWorkflowAssets, parseMarkdownAsset } from "./assets.js"
export { createSdkRunner } from "./runtime/sdk.js"
export { createFakeRunner } from "./runtime/fake.js"
export { formatWorkflowResult, summarizeOptions } from "./format.js"
export { resolveOptions } from "./options.js"
export * from "./types.js"

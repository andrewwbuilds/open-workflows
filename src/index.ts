import type { Plugin } from "@opencode-ai/plugin"
import { createDynamicWorkflowTool } from "./tool.js"
import type { DynamicWorkflowOptions } from "./types.js"

const DynamicWorkflowPlugin: Plugin = async (ctx, options) => {
  const pluginOptions = (options ?? {}) as DynamicWorkflowOptions
  const workflow = createDynamicWorkflowTool({
    client: ctx.client,
    pluginOptions,
  })
  return {
    tool: {
      dynamic_workflow: workflow,
    },
  }
}

export default DynamicWorkflowPlugin
export { DynamicWorkflowPlugin }
export { createDynamicWorkflowTool } from "./tool.js"
export { runWorkflow } from "./orchestrator.js"
export { createSdkRunner } from "./runtime/sdk.js"
export { createFakeRunner } from "./runtime/fake.js"
export { formatWorkflowResult, summarizeOptions } from "./format.js"
export { resolveOptions } from "./options.js"
export * from "./types.js"

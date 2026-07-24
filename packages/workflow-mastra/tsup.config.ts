import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/workflow-mastra v0.1.0-alpha
 * AIP-15 WORKFLOW.md → Mastra createWorkflow projection.
 */`,
  entry: {
    index: "src/index.ts",
  },
  format: ["esm"],
  splitting: false,
  dts: true,
  external: [
    "zod",
    "@mastra/core",
    "@mastra/core/workflows",
    "@agentproto/driver",
    "@agentproto/tool",
    "@agentproto/workflow-runtime",
  ],
  noExternal: [],
})

import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/workflow-ai-sdk v0.1.0-alpha
 * AIP-15 WORKFLOW.md → Vercel AI SDK dynamicTool projection.
 */`,
  entry: {
    index: "src/index.ts",
  },
  format: ["esm"],
  splitting: false,
  dts: true,
  external: ["zod", "ai", "@agentproto/workflow-runtime"],
  noExternal: [],
})

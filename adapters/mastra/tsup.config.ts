import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/adapter-mastra v0.1.0-alpha
 * Mastra adapter for AIP-30 ToolImplementations.
 */`,
  entry: { index: "src/index.ts" },
  format: ["esm"],
  splitting: false,
  dts: true,
  external: [
    "zod",
    "@mastra/core",
    "@mastra/core/tools",
    "@agentproto/driver",
    "@agentproto/tool",
  ],
  noExternal: [],
})

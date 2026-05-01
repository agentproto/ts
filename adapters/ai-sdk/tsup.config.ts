import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/adapter-ai-sdk v0.1.0-alpha
 * AI SDK adapter for AIP-30 ToolImplementations.
 */`,
  entry: { index: "src/index.ts" },
  format: ["esm"],
  splitting: false,
  dts: true,
  external: ["zod", "ai", "@agentproto/driver", "@agentproto/tool"],
  noExternal: [],
})

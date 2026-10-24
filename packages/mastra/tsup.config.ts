import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/mastra (deprecated shim)
 * Re-exports @agentproto/bridge unchanged.
 */`,
  entry: { index: "src/index.ts" },
  format: ["esm"],
  splitting: false,
  dts: false,
  external: ["@agentproto/bridge", "@agentproto/bridge/*", "@mastra/core", "@mastra/core/agent", "@mastra/core/processors"],
  noExternal: [],
})

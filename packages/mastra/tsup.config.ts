import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/mastra v0.1.0-alpha
 * AIP-42 AGENT.md → Mastra runtime adapter.
 */`,
  entry: { index: "src/index.ts" },
  format: ["esm"],
  splitting: false,
  dts: true,
  external: ["@agentproto/agent", "@mastra/core", "@mastra/core/agent"],
  noExternal: [],
})

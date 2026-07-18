import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/app-kit v0.1.0
 * Declare an agent + its workflows in one TS module (AIP-42 + AIP-15).
 */`,
  entry: { index: "src/index.ts" },
  format: ["esm"],
  splitting: false,
  // dts emitted by `tsc -p tsconfig.build.json` instead — @mastra/core's
  // own .d.ts has generic-variance issues that break rollup-plugin-dts
  // even when marked external (same trick @agentproto/mastra uses).
  dts: false,
  external: [
    "@agentproto/agent",
    "@agentproto/workflow",
    "@agentproto/mastra",
    "@mastra/core",
    "@mastra/core/agent",
    "gray-matter",
  ],
  noExternal: [],
})

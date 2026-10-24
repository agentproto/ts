import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/mastra v0.1.0-alpha
 * AIP-42 AGENT.md → Mastra runtime adapter.
 */`,
  entry: { index: "src/index.ts" },
  format: ["esm"],
  splitting: false,
  // dts emitted by `tsc -p tsconfig.build.json` instead — Mastra's own
  // .d.ts has variance issues that break rollup-plugin-dts even when
  // @mastra/core is marked external. tsc with skipLibCheck handles it.
  dts: false,
  external: ["@agentproto/agent", "@agentproto/corpus", "@mastra/core", "@mastra/core/agent", "@mastra/core/processors"],
  noExternal: [],
})

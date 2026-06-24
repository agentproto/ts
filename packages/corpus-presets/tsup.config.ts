import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/corpus-presets v0.1.0-alpha
 * Pure-TS starter workspaces for the AIP-10 corpus runtime.
 */`,
  entry: {
    index: "src/index.ts",
    "marketing/index": "src/marketing/index.ts",
    "research/index": "src/research/index.ts",
  },
  format: ["esm"],
  splitting: true,
  dts: true,
  external: ["@agentproto/corpus"],
})

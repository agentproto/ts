import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/social v0.1.0-alpha
 * Platform-neutral social footprint capture → AIP-10 corpus sources + graph ops.
 */`,
  entry: {
    index: "src/index.ts",
    "ports/index": "src/ports/index.ts",
  },
  format: ["esm"],
  splitting: true,
  dts: true,
  external: ["@agentproto/corpus"],
  noExternal: [],
})

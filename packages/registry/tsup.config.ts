import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/registry v0.1.0-alpha
 * AIP-43 REGISTRY reference implementation.
 */`,
  entry: {
    index: "src/index.ts",
  },
  format: ["esm"],
  splitting: false,
  dts: true,
  external: [],
  noExternal: [],
})

import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/doctype v0.1.0-alpha
 * Meta-factory for AIP defineX(definition) constructors.
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

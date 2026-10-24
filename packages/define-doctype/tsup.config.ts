import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/define-doctype v0.1.4 (deprecated shim)
 * Re-exports @agentproto/doctype unchanged.
 */`,
  entry: {
    index: "src/index.ts",
  },
  format: ["esm"],
  splitting: false,
  dts: true,
  external: ["@agentproto/doctype", "@agentproto/doctype/*"],
  noExternal: [],
})

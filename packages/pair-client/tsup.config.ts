import { createTsupConfig } from "@agentproto/tooling/tsup/base"

const entry = {
  index: "src/index.ts",
}

export default createTsupConfig({
  banner: `/**
 * @agentproto/pair-client v1.0.5 (deprecated shim)
 * Re-exports @agentproto/pairing unchanged.
 */`,
  entry,
  format: ["esm"],
  splitting: false,
  dts: { entry },
  external: ["@agentproto/pairing", "@agentproto/pairing/*"],
  noExternal: [],
})

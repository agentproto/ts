import { createTsupConfig } from "@agentproto/tooling/tsup/base"

const entry = {
  index: "src/index.ts",
}

export default createTsupConfig({
  banner: `/**
 * @agentproto/redaction v0.2.4 (deprecated shim)
 * Re-exports @agentproto/processor unchanged.
 */`,
  entry,
  format: ["esm"],
  splitting: false,
  dts: { entry },
  external: ["@agentproto/processor", "@agentproto/processor/*"],
  noExternal: [],
})

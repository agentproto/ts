import { createTsupConfig } from "@agentproto/tooling/tsup/base"

const entry = {
  index: "src/index.ts",
  types: "src/types.ts",
}

export default createTsupConfig({
  banner: `/**
 * @agentproto/harness v0.6.0 (deprecated shim)
 * Re-exports @agentproto/session-presets unchanged.
 */`,
  entry,
  format: ["esm"],
  splitting: true,
  dts: { entry },
  external: ["@agentproto/session-presets", "@agentproto/session-presets/*"],
  noExternal: [],
})

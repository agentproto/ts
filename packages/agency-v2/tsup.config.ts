import { createTsupConfig } from "@agentproto/tooling/tsup/base"

const entry = {
  index: "src/index.ts",
  "manifest/index": "src/manifest/index.ts",
}

export default createTsupConfig({
  banner: `/**
 * @agentproto/agency-v2 v0.1.5 (deprecated shim)
 * Re-exports @agentproto/agency unchanged.
 */`,
  entry,
  format: ["esm"],
  splitting: true,
  dts: { entry },
  external: ["@agentproto/agency", "@agentproto/agency/*"],
  noExternal: [],
})

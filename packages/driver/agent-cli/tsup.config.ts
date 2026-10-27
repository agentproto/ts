import { createTsupConfig } from "@agentproto/tooling/tsup/base"

const entry = {
  index: "src/index.ts",
  "manifest/index": "src/manifest/index.ts",
}

export default createTsupConfig({
  banner: `/**
 * @agentproto/driver-agent-cli v2.15.0 (deprecated shim)
 * Re-exports @agentproto/harness unchanged.
 */`,
  entry,
  format: ["esm"],
  splitting: true,
  dts: { entry },
  external: ["@agentproto/harness", "@agentproto/harness/*"],
  noExternal: [],
})

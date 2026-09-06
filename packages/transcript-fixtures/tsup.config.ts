import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/transcript-fixtures v0.1.0
 * Canonical RAW daemon-transcript fixtures — anti-drift conformity data.
 */`,
  entry: {
    index: "src/index.ts",
  },
  format: ["esm"],
  splitting: true,
  dts: true,
  external: [],
  noExternal: [],
})
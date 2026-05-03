import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/lifecycle v0.1.0-alpha
 * AIP-37 LIFECYCLE event-name vocabulary (Meta type — no doctype).
 */`,
  entry: {
    index: "src/index.ts",
  },
  format: ["esm"],
  dts: true,
  external: [],
})

import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/adapter-jcode v0.1.0
 * AIP-45 adapter for 1jehuang/jcode — RAM-efficient Rust coding agent.
 */`,
  entry: { index: "src/index.ts" },
  format: ["esm"],
  splitting: true,
  dts: true,
  external: [
    "@agentproto/driver-agent-cli",
    "@agentproto/model-catalog",
    "@agentproto/provider-kit",
  ],
  noExternal: [],
})

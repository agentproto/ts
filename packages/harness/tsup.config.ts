import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/harness v0.1.0-alpha
 * Typed one-call agent-session presets over the agentproto daemon.
 */`,
  entry: {
    index: "src/index.ts",
    types: "src/types.ts",
  },
  format: ["esm"],
  splitting: true,
  dts: true,
  external: ["@modelcontextprotocol/sdk", "zod"],
  noExternal: [],
})

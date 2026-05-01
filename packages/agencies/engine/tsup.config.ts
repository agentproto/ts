import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/agencies-engine v0.1.0-alpha
 * Workspace walkers + index helpers for agentagencies/v1. Vendor-neutral —
 * routes all I/O through @agentproto/governance-engine's IGovernanceFilesystem.
 */`,
  entry: {
    index: "src/index.ts",
  },
  format: ["esm"],
  splitting: false,
  dts: true,
  external: [
    "@agentproto/agencies",
    "@agentproto/governance-engine",
    "gray-matter",
    "node:path",
  ],
  noExternal: [],
})

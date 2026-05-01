import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/governance-engine v0.1.0-alpha
 * Reference engine for agentgovernance/v1 — audit chain + sign artifact +
 * pending-signatures index, all routed through IGovernanceFilesystem so the
 * same code runs against Node fs, Supabase Storage, S3, or in-memory.
 */`,
  entry: {
    index: "src/index.ts",
    "tools/index": "src/tools/index.ts",
    "provider/index": "src/provider/index.ts",
  },
  format: ["esm"],
  splitting: true,
  dts: true,
  external: [
    "@agentproto/governance",
    "@agentproto/driver",
    "@agentproto/ref",
    "@agentproto/tool",
    "zod",
    "node:crypto",
    "node:fs",
    "node:fs/promises",
    "node:path",
  ],
  noExternal: [],
})

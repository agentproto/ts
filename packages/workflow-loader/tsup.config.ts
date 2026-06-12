import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/workflow-loader v0.1.0-alpha
 * Disk loader + entry reconciliation for AIP-15 WORKFLOW.md.
 */`,
  entry: {
    index: "src/index.ts",
  },
  format: ["esm"],
  dts: true,
  external: ["@agentproto/workflow"],
})

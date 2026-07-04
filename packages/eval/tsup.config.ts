import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/eval v0.1.0
 * Deterministic reference scorers as AIP-14 TOOL contracts + builtin PROVIDER.
 */`,
  entry: {
    index: "src/index.ts",
  },
  format: ["esm"],
  splitting: true,
  dts: true,
  external: [
    "@agentproto/driver",
    "@agentproto/telemetry",
    "@agentproto/tool",
    "@agentproto/workflow-runtime",
    "zod",
  ],
  noExternal: [],
})

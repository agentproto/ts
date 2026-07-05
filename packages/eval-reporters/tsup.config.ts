import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/eval-reporters v0.1.0
 * Adapter-kit family for eval reporter backends.
 */`,
  entry: {
    index: "src/index.ts",
  },
  format: ["esm"],
  splitting: false,
  dts: true,
  external: [
    "@agentproto/provider-kit",
    "@agentproto/eval",
    "@agentproto/telemetry",
    "@agentproto/telemetry-langfuse",
    "zod",
  ],
  noExternal: [],
})

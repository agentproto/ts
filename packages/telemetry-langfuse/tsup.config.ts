import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/telemetry-langfuse v0.1.0
 * Dependency-free Langfuse ingestion REST API sink for agentproto eval events.
 */`,
  entry: {
    index: "src/index.ts",
  },
  format: ["esm"],
  splitting: false,
  dts: true,
  external: ["@agentproto/eval", "@agentproto/telemetry"],
  noExternal: [],
})

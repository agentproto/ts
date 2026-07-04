import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/telemetry v0.1.0
 * Vendor-neutral Telemetry port + reference sinks + OpenTelemetry adapter.
 */`,
  entry: {
    index: "src/index.ts",
  },
  format: ["esm"],
  splitting: false,
  dts: true,
  external: ["@opentelemetry/api"],
  noExternal: [],
})

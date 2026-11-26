import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/metric-source v0.1.0
 * Bijective TS <-> .md converter for declarative read-only metric sources.
 */`,
  entry: {
    index: "src/index.ts",
  },
  format: ["esm"],
  splitting: true,
  dts: true,
  external: [
    "zod",
    "gray-matter",
    "@agentproto/collection",
    "@agentproto/driver",
    "@agentproto/manifest",
    "@agentproto/routine",
    "@agentproto/tool",
  ],
  noExternal: [],
})

import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/plugin v0.1.0
 * Agent Plugins v1.0.0 cross-vendor plugin format reference implementation.
 */`,
  entry: { index: "src/index.ts" },
  format: ["esm"],
  splitting: false,
  dts: true,
  external: ["zod"],
  noExternal: [],
})

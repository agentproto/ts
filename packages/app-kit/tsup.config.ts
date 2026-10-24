import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/app-kit (deprecated shim)
 * Re-exports @agentproto/app unchanged.
 */`,
  entry: { index: "src/index.ts" },
  format: ["esm"],
  splitting: false,
  dts: false,
  external: ["@agentproto/app", "@agentproto/app/*", "@mastra/core", "@mastra/core/agent"],
  noExternal: [],
})

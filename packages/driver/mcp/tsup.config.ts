import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/mcp v0.1.0-alpha
 * AIP-32 MCP provider specialisation.
 */`,
  entry: { index: "src/index.ts" },
  format: ["esm"],
  splitting: true,
  dts: true,
  external: ["@agentproto/driver", "@agentproto/tool"],
  noExternal: [],
})

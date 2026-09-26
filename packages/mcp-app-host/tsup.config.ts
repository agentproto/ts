import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/mcp-app-host
 * Framework-free MCP Apps host over ext-apps' AppBridge.
 */`,
  entry: {
    index: "src/index.ts",
    dom: "src/dom.ts",
  },
  format: ["esm"],
  splitting: false,
  // dts emitted by `tsc -p tsconfig.build.json` (same split app-client uses).
  dts: false,
  external: ["@modelcontextprotocol/ext-apps", "@modelcontextprotocol/sdk"],
  noExternal: [],
})

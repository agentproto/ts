import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/mcp-server v0.1.0-alpha
 * MCP server exposing AIP doctype verbs (create / load / list / update / resolve / delete).
 */`,
  entry: { index: "src/index.ts" },
  format: ["esm"],
  splitting: false,
  dts: true,
  external: [
    "zod",
    "@agentproto/agent",
    "@agentproto/define-doctype",
    "@agentproto/extension",
    "@agentproto/manifest",
    "@agentproto/routine",
    "@agentproto/tool",
    "@modelcontextprotocol/sdk",
    "@modelcontextprotocol/sdk/server/index.js",
    "@modelcontextprotocol/sdk/server/mcp.js",
    "@modelcontextprotocol/sdk/server/stdio.js",
    "node:fs",
    "node:fs/promises",
    "node:path",
  ],
  noExternal: [],
})

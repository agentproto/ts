import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: `/**
 * @agentproto/runtime v0.1.0-alpha
 * Long-running gateway: MCP server + HTTP transport + HEARTBEAT autonomy + conversation persistence over a workspace dir.
 */`,
  entry: {
    index: "src/index.ts",
    conversations: "src/conversations.ts",
    heartbeat: "src/heartbeat.ts",
    "workspace-fs": "src/workspace-fs.ts",
    "workspaces-config": "src/workspaces-config.ts",
    config: "src/config.ts",
    "mcp-imports": "src/mcp-imports.ts",
    "resume-strategies": "src/resume-strategies.ts",
    "providers-store": "src/providers-store.ts",
    "session-story": "src/session-story.ts",
    "user-presets": "src/user-presets.ts",
  },
  format: ["esm"],
  splitting: false,
  dts: true,
  external: [
    "zod",
    "gray-matter",
    "@agentproto/agent",
    "@agentproto/manifest",
    "@agentproto/mcp-server",
    "@agentproto/model-catalog",
    "@agentproto/model-catalog/llm",
    "@agentproto/providers-store",
    "@modelcontextprotocol/sdk",
    "@modelcontextprotocol/sdk/server/mcp.js",
    "@modelcontextprotocol/sdk/server/streamableHttp.js",
    "node:fs",
    "node:fs/promises",
    "node:path",
    "node:http",
    "node:crypto",
    "node:events",
  ],
  noExternal: [],
})

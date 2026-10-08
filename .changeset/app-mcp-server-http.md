---
"@agentproto/runtime": minor
"@agentproto/cli": minor
"@agentproto/mcp-server": patch
---

Serve an app's bundled tools as an HTTP MCP server (`agentproto mcp-app` over HTTP, `@agentproto/runtime/app-mcp-server`). toMcpTool advertises real parameters for manifest-only (TOOL.md, JSON Schema) tools instead of an empty shape that made them uncallable.

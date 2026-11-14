---
"@agentproto/adapter-claude-code": minor
---

Add a `mcp_timeout` option (positive integer, milliseconds) that sets `MCP_TIMEOUT` in the claude process env, raising the MCP server startup connection timeout for slow cold-starting stdio servers.

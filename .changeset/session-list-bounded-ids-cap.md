---
"@agentproto/runtime": minor
"@agentproto/mcp-server": minor
---

fix(runtime,mcp-server): `session_list` returns at most 50 rows by default (`truncated`, `total`, `nextCursor` to page on) and accepts an `ids` filter to read known sessions; any contract-layer MCP tool result over 100 KB is replaced by `{truncated:true,totalBytes,hint}`

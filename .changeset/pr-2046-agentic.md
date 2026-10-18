---
"@agentproto/runtime": minor
"@agentproto/mcp-server": minor
---

Bound `session_list` results: an unpaged call now returns at most 50 rows plus `truncated`, `total` and `nextCursor` to page on, and a new `ids` filter reads known sessions without scanning the whole list. Any contract-layer MCP tool result over 100 KB is replaced by a `{truncated, totalBytes, hint}` marker.

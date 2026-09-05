---
"@agentproto/runtime": minor
---

Additive MCP pagination/tree params (PR-6): `mcp_imported_tool_list` gains `compact`/`schema` projections and `limit`/`cursor` paging (max 200) over the tool array; `session_tree` gains `groupByOrigin:false` to suppress the `byOrigin` companion view; `session_events_poll` accepts a forward-compat `full` flag. All defaults unchanged — omitting the new params returns today's byte-identical output.

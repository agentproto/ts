---
"@agentproto/mcp-server": minor
"@agentproto/app-client": minor
"@agentproto/apps": patch
---

A tool result over the MCP result cap (`MCP_RESULT_MAX_BYTES`) is now sent as an error result (`isError: true`) carrying the `{ truncated, totalBytes, hint }` marker, instead of a successful one. Clients that read lists leniently (`Array.isArray(r) ? r : []`, `r.items ?? []`) showed a truncated payload as an empty list; now every generic unwrapper rejects. `@agentproto/app-client` adds `McpResultTruncatedError` (a `McpToolError` subclass) and `parseTruncatedMarker`, raised for both the error form and the successful form older daemons sent. The inline app panels (config, ops-panel, session-viewer, media-viewer, mail-triage) share one `unwrapText` that throws on the marker nested in `app_tool_call`'s envelope, and the session-steward scan fails instead of silently dropping a page that came back as the marker.

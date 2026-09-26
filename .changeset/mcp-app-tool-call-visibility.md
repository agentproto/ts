---
"@agentproto/runtime": patch
---

`McpAppsHostService.callTool`'s app-UI allowlist now follows the MCP Apps spec (ext-apps `_meta.ui.visibility`): any tool of the hosting server is callable from its app UI unless the tool's `visibility` array explicitly excludes `"app"` (the default `["model", "app"]` applies when unset). Previously only a server's UI tools, its app-only tools, or the tool whose card hosts the app were allowed, so a widget's own plain data-fetch tools (no `_meta` at all) were wrongly refused with `is not callable from an app UI`.

Two follow-on fixes for the gate now depending on the server's full tool list: `PooledMcpClient` loops `tools/list` on `nextCursor` instead of reading only the first page, and the host strips `?deferred=1|0` from a session's daemon self-mount url before connecting, so deferred/lazy tool loading on an executor's own mount no longer makes the host misreport those tools as nonexistent.

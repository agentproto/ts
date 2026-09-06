---
"@agentproto/runtime": minor
---

Migrate the remaining `session-tools.ts` list tools onto the `ToolTransformer`
mechanism (`paginated()` + `catchErrors()`): `terminal_sessions_list`,
`command_list`, `mcp_discovered_list`, `mcp_imported_list`,
`mcp_imported_tool_list`, `session_queue_list`, and `worktree_status`.

Each tool now returns a COMPACT projection by default (identity/routing fields
+ small scalars); `full: true` / `compact: false` restores the complete
per-item record and `fields` allowlists per-item keys. Tool-visible behavior
changes:

- `mcp_imported_tool_list`: the bespoke `compact`/`schema` params are replaced
  by the shared `compact`/`full`/`fields` params (`full: true` keeps the
  upstream `inputSchema`); the `alias` echo is no longer repeated in the
  response body.
- `mcp_imported_list`: the top-level `version` field is no longer echoed in
  the default (non-paginated) response.
- `session_queue_list`: the `sessionId` echo is no longer repeated in the
  default response; `queuedAt` moves behind `full: true`.
- Error results across these tools collapse onto the canonical
  `{content:[{type:"text"}], isError}` shape (previously a mix of JSON
  `{error}` bodies and plain text).

Each tool's `project()` function is required by the `paginated()` transformer,
so there is no code path that accepts `compact` without implementing it.

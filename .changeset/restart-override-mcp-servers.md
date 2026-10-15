---
"@agentproto/runtime": minor
---

Restart-with-override: add `mcpServers` as a restartable axis (`POST /sessions/:id/restart` body, the `session_restart` MCP overrides, and `RestartOverrides` via `SessionConfig.mcpServers`). A restarted session now lets the caller fully REPLACE the mounted MCP server list instead of always cloning the ORIGINAL one verbatim — the only way to change an HTTP-mounted server's baked-in config (e.g. a `?allowTools=` query string on the daemon self-mount). Full replacement, not a merge; the daemon self-mount's `callerSessionId` is re-stamped with the restarted session's id on the new list.

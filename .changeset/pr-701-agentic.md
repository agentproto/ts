---
"@agentproto/runtime": patch
"agentproto-vscode": patch
---

Add `keepAlive` flag to allow sessions to opt out of idle-reaper auto-retirement. Sessions with `keepAlive: true` are never reaped regardless of idle time, useful for supervisors that legitimately park waiting on children or scheduled wakes. Configurable at spawn time via `agent_start`'s `keepAlive` parameter or toggled later with the new `session_set_keepalive` MCP tool. Persists across daemon restarts.

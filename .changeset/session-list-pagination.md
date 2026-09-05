---
"@agentproto/runtime": minor
---

Additive pagination for the session list tools: `session_list`, `agent_sessions_list`, `terminal_sessions_list` and `command_list` accept `limit`/`cursor` (plus `full`, currently a no-op) and return a `{ items, nextCursor?, total }` envelope when either is supplied. Without `limit`/`cursor` the output is unchanged.

---
"@agentproto/runtime": minor
---

Add `gcSessions()` method to bulk garbage-collect terminal sessions — archive (default, reversible) or forget (drop descriptor to reclaim disk). Supports age-based and scope-based filtering, never touches live sessions. Exposed via MCP tool `session_gc`.

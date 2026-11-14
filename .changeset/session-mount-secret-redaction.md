---
"@agentproto/runtime": patch
---

Session descriptors no longer leak mount secrets. Every outward projection (`session_list`, `session_search`, `agent_sessions_list`, `agent_start` with `full` or `fields`, and the HTTP session routes the CLI reads) now replaces `mcpServers[].env` and `mcpServers[].headers` values with `"[redacted]"` (keys kept) and blanks an `/mcp/orchestrator` scope-token in `ref`. The stored descriptor and the mounts handed to the adapter on spawn, restart and continue-fresh keep the real values.

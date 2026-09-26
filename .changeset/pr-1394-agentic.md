---
"@agentproto/runtime": minor
"@agentproto/cli": minor
"@agentproto/adapter-claude-code": patch
---

Deferred/lazy MCP tool loading: add per-mount `?deferred=1|0` query override, per-spawn/role `deferredTools` (executor defaults ON), and daemon-wide `defaults.mcp.deferredTools` config; extend the claude-code `lean` mode with native `ENABLE_TOOL_SEARCH`.

---
"@agentproto/runtime": minor
"@agentproto/driver-agent-cli": minor
"@agentproto/cli": minor
"@agentproto/adapter-claude-code": minor
---

The daemon's default self-mount `deferredTools` now depends on the harness: an adapter declaring the new manifest capability `nativeToolSearch` (claude-code, which defers MCP tools behind its own `ToolSearch`) gets the eager `/mcp` surface instead of a second deferral layer. Precedence: `agent_start.deferredTools` > `?deferred=` > native tool search ⇒ eager > role default > `defaults.mcp.deferredTools`. No tool is removed.

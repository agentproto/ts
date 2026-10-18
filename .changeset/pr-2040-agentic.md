---
"@agentproto/runtime": patch
---

Skip the unreachable host-loopback orchestrator MCP mount for `sandbox` spawns: an `orchestrator` request no longer mints a scope or injects a dead `/mcp/orchestrator` URL, and a clear warning is surfaced instead.

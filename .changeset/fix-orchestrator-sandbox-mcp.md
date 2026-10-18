---
"@agentproto/runtime": patch
---

A `sandbox` spawn with `orchestrator` now forwards the request onto the box's own `agentproto serve` daemon, so the sandboxed supervisor orchestrates children on the same box instead of being handed the host's unreachable loopback `/mcp/orchestrator` mount.

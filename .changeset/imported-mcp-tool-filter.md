---
"@agentproto/runtime": patch
---

The imported-MCP passthrough mount `/mcp/imported/<id>` now honours the same `?denyTools=` / `?allowTools=` query contract as `/mcp` (#2050). Filtered tools are hidden from `tools/list`, and a `tools/call` for a filtered name is rejected with a JSON-RPC error (`InvalidParams`) before it ever reaches the upstream import — enforcement, not just hiding. Deny is applied after allow; a name on both lists is excluded. Requests without the params behave exactly as before.

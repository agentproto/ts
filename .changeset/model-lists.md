---
"@agentproto/model-catalog": minor
"@agentproto/runtime": minor
"@agentproto/model-intel": patch
---

Add model lists with selectors, ordering and composition. A seeded `zero-cost` list (catalog price 0/0) replaces the free-model predicates, and the runtime enforces one generic `modelPolicy` (`allow`/`block` over list ids, set on `agent_start`) at spawn, `setModel`, restart and rotation instead of any free-versus-paid rule. Also, `getEnrichment` now tags zero-priced LLMs `price:zero` on both the explicit and inferred paths. The runtime gains a `~/.agentproto/model-lists.json` store plus `model_list_save`, `model_list_list`, `model_list_delete` and `model_list_resolve` MCP tools.

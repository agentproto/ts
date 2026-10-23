---
"@agentproto/model-catalog": minor
"@agentproto/model-intel": patch
"@agentproto/runtime": minor
---

Add model lists with selectors, ordering and composition. The new `zero-cost` list (seed: catalog price 0/0) replaces every free-model predicate in the runtime, and `getEnrichment` now tags zero-priced LLMs `price:zero` on both the explicit and inferred paths. The runtime gains a `~/.agentproto/model-lists.json` store plus `model_list_save`, `model_list_list`, `model_list_delete` and `model_list_resolve` MCP tools. `@agentproto/model-intel` reuses an internal `isZeroPriced` helper for the same rule.

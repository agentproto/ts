---
"@agentproto/runtime": minor
---

Add adapter-capability spawn guard to prevent spawning with models the adapter doesn't support on a resolved route.

The bug: a supervisor spawned `agent_start({adapter:"claude-code", model:"openrouter/deepseek/deepseek-v4-flash-0731"})` with no explicit `route.gateway`. The money-safety wallet guard (checkModelWalletEligibility) passed — openrouter genuinely bills that model. But claude-code's own manifest never curates that specific model on that route; its ACP wrapper validates against its own live selector and rejects anything it doesn't recognize. The upstream 404 reached the driver, leaving 0 tool calls.

The fix: before spawn and restart, check whether the adapter is among the resolved (vendor, product, route) row's adapters in the catalog. Reuses the exact same `buildCatalogModels` join `catalog_models` reports — never a parallel per-model table. Optional dependency: skipped when `listCatalogModels` isn't wired, preserving pre-guard behavior.

Adds:
- `checkModelAdapterEligibility` predicate function
- `modelAdapterIncompatibleMessage` message formatter
- `ModelAdapterEligibility` result interface
- New error code `model_adapter_incompatible` on spawn/restart failures

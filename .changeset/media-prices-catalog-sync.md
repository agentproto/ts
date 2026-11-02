---
"@agentproto/catalog-sync": patch
"@agentproto/model-catalog": patch
---

Add media price syncing: an OpenRouter image/video generator that records per-token output prices from committed snapshots, a Replicate model-page parser plus sync script for per-unit and hardware-billed per-second prices, and route-keyed `OPENROUTER_*_PRICING` / `REPLICATE_IMAGE_PRICING` maps exported from `@agentproto/model-catalog`. `run-all.mjs` now names outputs and changelog sections per modality (`### image:replicate`) while keeping the LLM paths unchanged.

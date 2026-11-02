---
"@agentproto/catalog-sync": minor
"@agentproto/model-catalog": minor
---

Add media price syncing: an OpenRouter image/video generator that records per-token output prices from committed snapshots, a Replicate model-page parser plus sync script covering the hand-written Replicate price table and the Replicate image/video models used by the catalog, and route-keyed `OPENROUTER_*_PRICING` / `REPLICATE_*_PRICING` maps exported from `@agentproto/model-catalog`. `image:replicate` now reads the scraped map and keeps the hand-written table only as a marked fallback. `run-all.mjs` names outputs and changelog sections per modality (`### image:replicate`) while keeping the LLM paths unchanged. Replicate pages that bill several distinct tier prices (per resolution or duration) are no longer collapsed to their first tier: they are left out of the scraped map and `image:replicate` uses its hand-written fallback. `fetchedAt` is now stamped per route/model from an order-independent hash, and `run-all.mjs` logs both the image and video outputs of `sync-replicate.mjs`.

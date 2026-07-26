---
"@agentproto/runtime": patch
---

Map xAI pricing-catalog models to both the native `xai` route and the Anthropic-compatible `xai-anthropic` route so stored `xai` and `xai-anthropic` auth profiles resolve models correctly in the catalog. Registers `xai-anthropic` as a built-in custom route and surfaces compatibility rows for every xAI-priced model, fixing the UI showing 0 active / 0 models for these profiles.

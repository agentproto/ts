---
"@agentproto/model-catalog": patch
---

Add catalog sync scripts for Mistral and Moonshot: ids from each provider's
live /v1/models (with OpenRouter fallback for Moonshot), pricing from
OpenRouter's public API, emitted as generated files spread beneath the
hand-maintained entries so curated pricing always overrides.

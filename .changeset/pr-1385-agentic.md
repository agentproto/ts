---
"@agentproto/catalog-sync": minor
"@agentproto/model-catalog": minor
---

OpenAI catalog now syncs from OpenAI's own sources: ids from `GET /v1/models` (authed via `OPENAI_API_KEY`, falling back to OpenRouter ids without a key) and prices from OpenAI's published pricing Markdown (`platform.openai.com/docs/pricing.md`), parsed by column name and sanity-checked, with OpenRouter as the per-row fallback. New exports `OPENAI_MODELS_SOURCE` and `OPENAI_PRICING_SOURCE` (with `OPENAI_LLM_SOURCE` kept as a back-compat alias); `LLMPricing` gains optional `priceSource`/`idSource` provenance fields, and a new generated `OPENAI_GENERATED_UNPRICED_IDS` list keeps OpenAI-listed but unpriced ids as known members of `LlmModelId`.

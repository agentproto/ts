---
"@agentproto/model-catalog": minor
"@agentproto/catalog-sync": minor
"@agentproto/runtime": patch
---

Prompt-length pricing tiers. `LLMPricing` gains an optional `tiers: [{ aboveInputTokens, inputPer1M, outputPer1M, cacheReadMultiplier?, cacheWriteMultiplier? }]`, and the new `selectPricingTier(pricing, promptTokens)` flattens a row to the rates for a given prompt length. `calculateLLMCreditCost` (and so `calculateCost` and `getCacheStats`) bills the whole request at the tier its prompt falls in, counting cache-read and cache-write input toward that length. Claude Haiku 5.5 is $0.10/$0.50 up to 100k prompt tokens and $0.50/$2.50 over it, so long prompts were priced 5x too low before this. The `llm:openrouter` generator and `scripts/catalog-sync/sync-anthropic.mjs` emit tiers from OpenRouter's `pricing.overrides` (`min_prompt_tokens` entries only; time-of-day discounts are ignored). Runtime session cost picks the tier from the latest request's `contextUsed`.

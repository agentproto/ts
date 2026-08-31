---
"@agentproto/adapter-claude-code": patch
"@agentproto/adapter-claude-sdk": patch
"@agentproto/catalog-sync": patch
"@agentproto/model-catalog": minor
---

Refactor model catalog to derive existence from live-synced sources, not hand-typed pricing rows.

**Model existence inversion**: `LlmModelId` union now derives from `CONTEXT_WINDOWS` + `OPENROUTER_ROUTES` keys, with pricing overlaid on top. Hand-written pricing is now bounded to the `PRICING_OVERRIDES` map (rare edge cases only).

**Native model lists**: Both Anthropic adapters now use `listNativeModelIds("anthropic")` with an empty denylist, eliminating the hand-maintained list. Google native ids extracted to `google-native-model-ids.mjs` for reuse across sync scripts.

**Sync scripts**: Added generators for Anthropic, xAI, Google, OpenAI, MiniMax. Fallback strategy: Anthropic uses `CONTEXT_WINDOWS` when API key unavailable.

**Pricing optionality**: `ResolvedModel.pricing?: LLMPricing` signals "known but unpriced" models. Consumers updated (enrichment, registry, cost dispatcher).

**Data quality**: Generated prices replace stale hand-typed entries. No pricing regressions; Anthropic, Mistral, Moonshot, Groq all carry live sync-derived values or documented placeholders.

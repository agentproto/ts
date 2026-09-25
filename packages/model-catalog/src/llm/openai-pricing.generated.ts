// GENERATED FILE — do not edit; regenerate with scripts/catalog-sync/sync-openai.mjs
// (ids: api.openai.com/v1/models, union openrouter.ai/api/v1/models openai/*; prices: platform.openai.com/docs/pricing.md, OpenRouter fallback per row; synced 2026-09-25T14:49:34.811Z)
//
// Provenance is recorded PER ROW — `idSource` says which list the id came
// from, `priceSource` which source priced it:
//   idSource "openai"     — listed by GET api.openai.com/v1/models
//   idSource "openrouter" — only on openrouter.ai/api/v1/models under openai/*.
//                           Kept, not dropped: /v1/models is scoped to the
//                           calling account, and this set is mostly ids that
//                           cannot appear there at all (`:batch` is a separate
//                           endpoint; `gpt-oss-*` is open-weights).
//   priceSource "openai"     — platform.openai.com/docs/pricing.md, OpenAI's
//                              own Markdown rendering of the pricing page,
//                              parsed by column NAME from its GFM tables.
//                              Short-context standard rate; `:batch` rows are
//                              priced from that page's Batch table.
//   priceSource "openrouter" — OpenRouter's passthrough rate, which may differ
//                              from OpenAI's first-party pricing.

export const OPENAI_GENERATED_PRICING = {
  "gpt-3.5-turbo": { inputPer1M: 0.5, outputPer1M: 1.5, vendor: "openai", provider: "openai", priceSource: "openai", idSource: "openai" },
  "gpt-3.5-turbo-0125": { inputPer1M: 0.5, outputPer1M: 1.5, vendor: "openai", provider: "openai", priceSource: "openai", idSource: "openai" },
  "gpt-3.5-turbo-0613": { inputPer1M: 1, outputPer1M: 2, vendor: "openai", provider: "openai", priceSource: "openrouter", idSource: "openrouter" },
  "gpt-3.5-turbo-1106": { inputPer1M: 1, outputPer1M: 2, vendor: "openai", provider: "openai", priceSource: "openai", idSource: "openai" },
  "gpt-3.5-turbo-16k": { inputPer1M: 3, outputPer1M: 4, vendor: "openai", provider: "openai", priceSource: "openrouter", idSource: "openai" },
  "gpt-3.5-turbo-instruct": { inputPer1M: 1.5, outputPer1M: 2, vendor: "openai", provider: "openai", priceSource: "openai", idSource: "openai" },
  "gpt-3.5-turbo:batch": { inputPer1M: 0.25, outputPer1M: 0.75, vendor: "openai", provider: "openai", priceSource: "openrouter", idSource: "openrouter" },
  "gpt-4": { inputPer1M: 30, outputPer1M: 60, vendor: "openai", provider: "openai", priceSource: "openrouter", idSource: "openai" },
  "gpt-4-0613": { inputPer1M: 30, outputPer1M: 60, vendor: "openai", provider: "openai", priceSource: "openai", idSource: "openai" },
  "gpt-4-turbo": { inputPer1M: 10, outputPer1M: 30, vendor: "openai", provider: "openai", priceSource: "openrouter", idSource: "openai" },
  "gpt-4-turbo-2024-04-09": { inputPer1M: 10, outputPer1M: 30, vendor: "openai", provider: "openai", priceSource: "openai", idSource: "openai" },
  "gpt-4-turbo:batch": { inputPer1M: 5, outputPer1M: 15, vendor: "openai", provider: "openai", priceSource: "openrouter", idSource: "openrouter" },
  "gpt-4.1": { inputPer1M: 2, outputPer1M: 8, cacheReadMultiplier: 0.25, vendor: "openai", provider: "openai", priceSource: "openai", idSource: "openai" },
  "gpt-4.1-mini": { inputPer1M: 0.4, outputPer1M: 1.6, cacheReadMultiplier: 0.25, vendor: "openai", provider: "openai", priceSource: "openai", idSource: "openai" },
  "gpt-4.1-mini:batch": { inputPer1M: 0.2, outputPer1M: 0.8, vendor: "openai", provider: "openai", priceSource: "openai", idSource: "openrouter" },
  "gpt-4.1-nano": { inputPer1M: 0.1, outputPer1M: 0.4, cacheReadMultiplier: 0.25, vendor: "openai", provider: "openai", priceSource: "openai", idSource: "openai" },
  "gpt-4.1-nano:batch": { inputPer1M: 0.05, outputPer1M: 0.2, vendor: "openai", provider: "openai", priceSource: "openai", idSource: "openrouter" },
  "gpt-4.1:batch": { inputPer1M: 1, outputPer1M: 4, vendor: "openai", provider: "openai", priceSource: "openai", idSource: "openrouter" },
  "gpt-4o": { inputPer1M: 2.5, outputPer1M: 10, cacheReadMultiplier: 0.5, vendor: "openai", provider: "openai", priceSource: "openai", idSource: "openai" },
  "gpt-4o-2024-05-13": { inputPer1M: 5, outputPer1M: 15, vendor: "openai", provider: "openai", priceSource: "openai", idSource: "openai" },
  "gpt-4o-2024-08-06": { inputPer1M: 2.5, outputPer1M: 10, cacheReadMultiplier: 0.5, vendor: "openai", provider: "openai", priceSource: "openrouter", idSource: "openai" },
  "gpt-4o-2024-11-20": { inputPer1M: 2.5, outputPer1M: 10, cacheReadMultiplier: 0.5, vendor: "openai", provider: "openai", priceSource: "openrouter", idSource: "openai" },
  "gpt-4o-mini": { inputPer1M: 0.15, outputPer1M: 0.6, cacheReadMultiplier: 0.5, vendor: "openai", provider: "openai", priceSource: "openai", idSource: "openai" },
  "gpt-4o-mini-2024-07-18": { inputPer1M: 0.15, outputPer1M: 0.6, cacheReadMultiplier: 0.5, vendor: "openai", provider: "openai", priceSource: "openrouter", idSource: "openai" },
  "gpt-4o-mini:batch": { inputPer1M: 0.075, outputPer1M: 0.3, vendor: "openai", provider: "openai", priceSource: "openai", idSource: "openrouter" },
  "gpt-4o:batch": { inputPer1M: 1.25, outputPer1M: 5, vendor: "openai", provider: "openai", priceSource: "openai", idSource: "openrouter" },
  "gpt-5": { inputPer1M: 1.25, outputPer1M: 10, cacheReadMultiplier: 0.1, vendor: "openai", provider: "openai", priceSource: "openai", idSource: "openai" },
  "gpt-5-image": { inputPer1M: 10, outputPer1M: 10, cacheReadMultiplier: 0.125, vendor: "openai", provider: "openai", priceSource: "openrouter", idSource: "openrouter" },
  "gpt-5-image-mini": { inputPer1M: 2.5, outputPer1M: 2, cacheReadMultiplier: 0.1, vendor: "openai", provider: "openai", priceSource: "openrouter", idSource: "openrouter" },
  "gpt-5-mini": { inputPer1M: 0.25, outputPer1M: 2, cacheReadMultiplier: 0.1, vendor: "openai", provider: "openai", priceSource: "openai", idSource: "openai" },
  "gpt-5-mini:batch": { inputPer1M: 0.125, outputPer1M: 1, cacheReadMultiplier: 0.1, vendor: "openai", provider: "openai", priceSource: "openai", idSource: "openrouter" },
  "gpt-5-nano": { inputPer1M: 0.05, outputPer1M: 0.4, cacheReadMultiplier: 0.1, vendor: "openai", provider: "openai", priceSource: "openai", idSource: "openai" },
  "gpt-5-nano:batch": { inputPer1M: 0.025, outputPer1M: 0.2, cacheReadMultiplier: 0.1, vendor: "openai", provider: "openai", priceSource: "openai", idSource: "openrouter" },
  "gpt-5-pro": { inputPer1M: 15, outputPer1M: 120, vendor: "openai", provider: "openai", priceSource: "openai", idSource: "openai" },
  "gpt-5-pro:batch": { inputPer1M: 7.5, outputPer1M: 60, vendor: "openai", provider: "openai", priceSource: "openai", idSource: "openrouter" },
  "gpt-5-search-api": { inputPer1M: 1.25, outputPer1M: 10, cacheReadMultiplier: 0.1, vendor: "openai", provider: "openai", priceSource: "openai", idSource: "openai" },
  "gpt-5:batch": { inputPer1M: 0.625, outputPer1M: 5, cacheReadMultiplier: 0.1, vendor: "openai", provider: "openai", priceSource: "openai", idSource: "openrouter" },
  "gpt-5.1": { inputPer1M: 1.25, outputPer1M: 10, cacheReadMultiplier: 0.1, vendor: "openai", provider: "openai", priceSource: "openai", idSource: "openai" },
  "gpt-5.1-codex": { inputPer1M: 1.25, outputPer1M: 10, cacheReadMultiplier: 0.104, vendor: "openai", provider: "openai", priceSource: "openrouter", idSource: "openai" },
  "gpt-5.1-codex-max": { inputPer1M: 1.25, outputPer1M: 10, cacheReadMultiplier: 0.1, vendor: "openai", provider: "openai", priceSource: "openrouter", idSource: "openai" },
  "gpt-5.1-codex-mini": { inputPer1M: 0.25, outputPer1M: 2, cacheReadMultiplier: 0.12, vendor: "openai", provider: "openai", priceSource: "openrouter", idSource: "openai" },
  "gpt-5.1:batch": { inputPer1M: 0.625, outputPer1M: 5, cacheReadMultiplier: 0.1, vendor: "openai", provider: "openai", priceSource: "openai", idSource: "openrouter" },
  "gpt-5.2": { inputPer1M: 1.75, outputPer1M: 14, cacheReadMultiplier: 0.1, vendor: "openai", provider: "openai", priceSource: "openai", idSource: "openai" },
  "gpt-5.2-chat": { inputPer1M: 1.75, outputPer1M: 14, cacheReadMultiplier: 0.1, vendor: "openai", provider: "openai", priceSource: "openrouter", idSource: "openrouter" },
  "gpt-5.2-codex": { inputPer1M: 1.75, outputPer1M: 14, cacheReadMultiplier: 0.1, vendor: "openai", provider: "openai", priceSource: "openrouter", idSource: "openai" },
  "gpt-5.2-pro": { inputPer1M: 21, outputPer1M: 168, vendor: "openai", provider: "openai", priceSource: "openai", idSource: "openai" },
  "gpt-5.2-pro:batch": { inputPer1M: 10.5, outputPer1M: 84, vendor: "openai", provider: "openai", priceSource: "openai", idSource: "openrouter" },
  "gpt-5.2:batch": { inputPer1M: 0.875, outputPer1M: 7, cacheReadMultiplier: 0.1, vendor: "openai", provider: "openai", priceSource: "openai", idSource: "openrouter" },
  "gpt-5.3-codex": { inputPer1M: 1.75, outputPer1M: 14, cacheReadMultiplier: 0.1, vendor: "openai", provider: "openai", priceSource: "openai", idSource: "openai" },
  "gpt-5.4": { inputPer1M: 2.5, outputPer1M: 15, cacheReadMultiplier: 0.1, vendor: "openai", provider: "openai", priceSource: "openai", idSource: "openai" },
  "gpt-5.4-mini": { inputPer1M: 0.75, outputPer1M: 4.5, cacheReadMultiplier: 0.1, vendor: "openai", provider: "openai", priceSource: "openai", idSource: "openai" },
  "gpt-5.4-mini:batch": { inputPer1M: 0.375, outputPer1M: 2.25, cacheReadMultiplier: 0.1, vendor: "openai", provider: "openai", priceSource: "openai", idSource: "openrouter" },
  "gpt-5.4-nano": { inputPer1M: 0.2, outputPer1M: 1.25, cacheReadMultiplier: 0.1, vendor: "openai", provider: "openai", priceSource: "openai", idSource: "openai" },
  "gpt-5.4-nano:batch": { inputPer1M: 0.1, outputPer1M: 0.625, cacheReadMultiplier: 0.1, vendor: "openai", provider: "openai", priceSource: "openai", idSource: "openrouter" },
  "gpt-5.4-pro": { inputPer1M: 30, outputPer1M: 180, vendor: "openai", provider: "openai", priceSource: "openai", idSource: "openai" },
  "gpt-5.4-pro:batch": { inputPer1M: 15, outputPer1M: 90, vendor: "openai", provider: "openai", priceSource: "openai", idSource: "openrouter" },
  "gpt-5.4:batch": { inputPer1M: 1.25, outputPer1M: 7.5, cacheReadMultiplier: 0.104, vendor: "openai", provider: "openai", priceSource: "openai", idSource: "openrouter" },
  "gpt-5.5": { inputPer1M: 5, outputPer1M: 30, cacheReadMultiplier: 0.1, vendor: "openai", provider: "openai", priceSource: "openai", idSource: "openai" },
  "gpt-5.5-pro": { inputPer1M: 30, outputPer1M: 180, vendor: "openai", provider: "openai", priceSource: "openai", idSource: "openai" },
  "gpt-5.5-pro:batch": { inputPer1M: 15, outputPer1M: 90, vendor: "openai", provider: "openai", priceSource: "openai", idSource: "openrouter" },
  "gpt-5.5:batch": { inputPer1M: 2.5, outputPer1M: 15, cacheReadMultiplier: 0.1, vendor: "openai", provider: "openai", priceSource: "openai", idSource: "openrouter" },
  "gpt-5.6-luna": { inputPer1M: 0.2, outputPer1M: 1.2, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25, vendor: "openai", provider: "openai", priceSource: "openai", idSource: "openai" },
  "gpt-5.6-luna-pro": { inputPer1M: 0.2, outputPer1M: 1.2, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25, vendor: "openai", provider: "openai", priceSource: "openrouter", idSource: "openrouter" },
  "gpt-5.6-luna-pro:batch": { inputPer1M: 0.1, outputPer1M: 0.6, cacheReadMultiplier: 0.1, vendor: "openai", provider: "openai", priceSource: "openrouter", idSource: "openrouter" },
  "gpt-5.6-luna:batch": { inputPer1M: 0.1, outputPer1M: 0.6, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25, vendor: "openai", provider: "openai", priceSource: "openai", idSource: "openrouter" },
  "gpt-5.6-sol": { inputPer1M: 4, outputPer1M: 20, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25, vendor: "openai", provider: "openai", priceSource: "openai", idSource: "openai" },
  "gpt-5.6-sol-pro": { inputPer1M: 2, outputPer1M: 10, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25, vendor: "openai", provider: "openai", priceSource: "openrouter", idSource: "openrouter" },
  "gpt-5.6-sol-pro:batch": { inputPer1M: 1, outputPer1M: 5, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25, vendor: "openai", provider: "openai", priceSource: "openrouter", idSource: "openrouter" },
  "gpt-5.6-sol:batch": { inputPer1M: 2, outputPer1M: 10, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25, vendor: "openai", provider: "openai", priceSource: "openai", idSource: "openrouter" },
  "gpt-5.6-terra": { inputPer1M: 2, outputPer1M: 12, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25, vendor: "openai", provider: "openai", priceSource: "openai", idSource: "openai" },
  "gpt-5.6-terra-pro": { inputPer1M: 2, outputPer1M: 12, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25, vendor: "openai", provider: "openai", priceSource: "openrouter", idSource: "openrouter" },
  "gpt-5.6-terra-pro:batch": { inputPer1M: 1, outputPer1M: 6, cacheReadMultiplier: 0.1, vendor: "openai", provider: "openai", priceSource: "openrouter", idSource: "openrouter" },
  "gpt-5.6-terra:batch": { inputPer1M: 1, outputPer1M: 6, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25, vendor: "openai", provider: "openai", priceSource: "openai", idSource: "openrouter" },
  "gpt-6-astra": { inputPer1M: 10, outputPer1M: 50, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25, vendor: "openai", provider: "openai", priceSource: "openai", idSource: "openai" },
  "gpt-6-astra-pro": { inputPer1M: 10, outputPer1M: 50, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25, vendor: "openai", provider: "openai", priceSource: "openrouter", idSource: "openrouter" },
  "gpt-6-astra-pro:batch": { inputPer1M: 5, outputPer1M: 25, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25, vendor: "openai", provider: "openai", priceSource: "openrouter", idSource: "openrouter" },
  "gpt-6-astra:batch": { inputPer1M: 5, outputPer1M: 25, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25, vendor: "openai", provider: "openai", priceSource: "openai", idSource: "openrouter" },
  "gpt-6-luna": { inputPer1M: 0.1, outputPer1M: 0.5, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25, vendor: "openai", provider: "openai", priceSource: "openai", idSource: "openai" },
  "gpt-6-luna-pro": { inputPer1M: 0.1, outputPer1M: 0.5, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25, vendor: "openai", provider: "openai", priceSource: "openrouter", idSource: "openrouter" },
  "gpt-6-luna-pro:batch": { inputPer1M: 0.05, outputPer1M: 0.25, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25, vendor: "openai", provider: "openai", priceSource: "openrouter", idSource: "openrouter" },
  "gpt-6-luna:batch": { inputPer1M: 0.05, outputPer1M: 0.25, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25, vendor: "openai", provider: "openai", priceSource: "openai", idSource: "openrouter" },
  "gpt-6-sol": { inputPer1M: 2, outputPer1M: 10, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25, vendor: "openai", provider: "openai", priceSource: "openai", idSource: "openai" },
  "gpt-6-sol-pro": { inputPer1M: 2, outputPer1M: 10, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25, vendor: "openai", provider: "openai", priceSource: "openrouter", idSource: "openrouter" },
  "gpt-6-sol-pro:batch": { inputPer1M: 1, outputPer1M: 5, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25, vendor: "openai", provider: "openai", priceSource: "openrouter", idSource: "openrouter" },
  "gpt-6-sol:batch": { inputPer1M: 1, outputPer1M: 5, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25, vendor: "openai", provider: "openai", priceSource: "openai", idSource: "openrouter" },
  "gpt-audio": { inputPer1M: 2.5, outputPer1M: 10, vendor: "openai", provider: "openai", priceSource: "openrouter", idSource: "openai" },
  "gpt-audio-mini": { inputPer1M: 0.6, outputPer1M: 2.4, vendor: "openai", provider: "openai", priceSource: "openrouter", idSource: "openai" },
  "gpt-chat-latest": { inputPer1M: 5, outputPer1M: 30, cacheReadMultiplier: 0.1, vendor: "openai", provider: "openai", priceSource: "openrouter", idSource: "openrouter" },
  "gpt-oss-120b": { inputPer1M: 0.15, outputPer1M: 0.6, cacheReadMultiplier: 0.5, vendor: "openai", provider: "openai", priceSource: "openrouter", idSource: "openrouter" },
  "gpt-oss-120b:batch": { inputPer1M: 0.0296, outputPer1M: 0.136, vendor: "openai", provider: "openai", priceSource: "openrouter", idSource: "openrouter" },
  "gpt-oss-20b": { inputPer1M: 0.018, outputPer1M: 0.09, vendor: "openai", provider: "openai", priceSource: "openrouter", idSource: "openrouter" },
  "gpt-oss-20b:batch": { inputPer1M: 0.024, outputPer1M: 0.112, vendor: "openai", provider: "openai", priceSource: "openrouter", idSource: "openrouter" },
  "gpt-oss-safeguard-20b": { inputPer1M: 0.075, outputPer1M: 0.3, cacheReadMultiplier: 0.5, vendor: "openai", provider: "openai", priceSource: "openrouter", idSource: "openrouter" },
  "o1": { inputPer1M: 15, outputPer1M: 60, cacheReadMultiplier: 0.5, vendor: "openai", provider: "openai", priceSource: "openai", idSource: "openai" },
  "o1-pro": { inputPer1M: 150, outputPer1M: 600, vendor: "openai", provider: "openai", priceSource: "openai", idSource: "openai" },
  "o3": { inputPer1M: 2, outputPer1M: 8, cacheReadMultiplier: 0.25, vendor: "openai", provider: "openai", priceSource: "openai", idSource: "openai" },
  "o3-mini": { inputPer1M: 1.1, outputPer1M: 4.4, cacheReadMultiplier: 0.5, vendor: "openai", provider: "openai", priceSource: "openai", idSource: "openai" },
  "o3-mini-high": { inputPer1M: 1.1, outputPer1M: 4.4, cacheReadMultiplier: 0.5, vendor: "openai", provider: "openai", priceSource: "openrouter", idSource: "openrouter" },
  "o3-mini:batch": { inputPer1M: 0.55, outputPer1M: 2.2, vendor: "openai", provider: "openai", priceSource: "openai", idSource: "openrouter" },
  "o3-pro": { inputPer1M: 20, outputPer1M: 80, vendor: "openai", provider: "openai", priceSource: "openai", idSource: "openrouter" },
  "o3:batch": { inputPer1M: 1, outputPer1M: 4, vendor: "openai", provider: "openai", priceSource: "openai", idSource: "openrouter" },
  "o4-mini": { inputPer1M: 1.1, outputPer1M: 4.4, cacheReadMultiplier: 0.25, vendor: "openai", provider: "openai", priceSource: "openai", idSource: "openai" },
  "o4-mini-high": { inputPer1M: 1.1, outputPer1M: 4.4, cacheReadMultiplier: 0.25, vendor: "openai", provider: "openai", priceSource: "openrouter", idSource: "openrouter" },
  "o4-mini:batch": { inputPer1M: 0.55, outputPer1M: 2.2, vendor: "openai", provider: "openai", priceSource: "openai", idSource: "openrouter" },
} as const

/**
 * OpenAI-listed ids with NO price from either source — emitted as
 * existence-only so they are real members of `LlmModelId` and answer true
 * to `isKnownLlmId`, without a fabricated zero in `LLM_PRICING_CATALOG`.
 * "Does this model exist" and "what does it cost" are independent questions
 * in this catalog by design — see `LlmModelId`'s doc comment. Most of these
 * are dated snapshots (`gpt-5.4-2026-03-05`) and aliases the docs pricing
 * page lists only under their undated base id; deriving a price from that
 * base would be inference, not data, so it is not done.
 *
 * `chat-latest` is here for a different reason — it IS officially priced,
 * but a bare key that generic would win `resolvePricing`'s substring scan
 * against every `*-chat-latest` id and reprice them. See
 * `AMBIGUOUS_BARE_IDS` in catalog-sync's `sources/openai-catalog.mjs`.
 */
export const OPENAI_GENERATED_UNPRICED_IDS = [
  "chat-latest",
  "gpt-3.5-turbo-instruct-0914",
  "gpt-4.1-2025-04-14",
  "gpt-4.1-mini-2025-04-14",
  "gpt-4.1-nano-2025-04-14",
  "gpt-4o-mini-search-preview",
  "gpt-4o-mini-search-preview-2025-03-11",
  "gpt-4o-search-preview",
  "gpt-4o-search-preview-2025-03-11",
  "gpt-5-2025-08-07",
  "gpt-5-chat-latest",
  "gpt-5-codex",
  "gpt-5-mini-2025-08-07",
  "gpt-5-nano-2025-08-07",
  "gpt-5-pro-2025-10-06",
  "gpt-5-search-api-2025-10-14",
  "gpt-5.1-2025-11-13",
  "gpt-5.1-chat-latest",
  "gpt-5.2-2025-12-11",
  "gpt-5.2-chat-latest",
  "gpt-5.2-pro-2025-12-11",
  "gpt-5.3-chat-latest",
  "gpt-5.4-2026-03-05",
  "gpt-5.4-mini-2026-03-17",
  "gpt-5.4-nano-2026-03-17",
  "gpt-5.4-pro-2026-03-05",
  "gpt-5.5-2026-04-23",
  "gpt-5.5-pro-2026-04-23",
  "gpt-audio-1.5",
  "gpt-audio-2025-08-28",
  "gpt-audio-mini-2025-10-06",
  "gpt-audio-mini-2025-12-15",
  "o1-2024-12-17",
  "o1-pro-2025-03-19",
  "o3-2025-04-16",
  "o3-mini-2025-01-31",
  "o4-mini-2025-04-16",
] as const

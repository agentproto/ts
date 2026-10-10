// GENERATED FILE — do not edit; regenerate with scripts/catalog-sync/sync-minimax.mjs
// (ids: MiniMax pricing page + committed PascalCase list, pricing: platform.minimax.io pay-as-you-go pricing page, OpenRouter /v1/models (minimax/*) fallback per row, synced 2026-10-10T01:18:23.129Z)
// OpenRouter fallback rows: normalization lowercase → prepend "minimax-" when
// missing; OpenRouter's minimax/* routes carry no input_cache_write, so those
// rows have no cacheWriteMultiplier.

export const MINIMAX_GENERATED_PRICING = {
  "M2-her": { inputPer1M: 0.3, outputPer1M: 1.2, cacheReadMultiplier: 0.1, priceSource: "openrouter", vendor: "minimax", provider: "minimax" },
  "MiniMax-M2": { inputPer1M: 0.3, outputPer1M: 1.2, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25, priceSource: "minimax", vendor: "minimax", provider: "minimax" },
  "MiniMax-M2.1": { inputPer1M: 0.3, outputPer1M: 1.2, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25, priceSource: "minimax", vendor: "minimax", provider: "minimax" },
  "MiniMax-M2.1-highspeed": { inputPer1M: 0.6, outputPer1M: 2.4, cacheReadMultiplier: 0.05, cacheWriteMultiplier: 0.625, priceSource: "minimax", vendor: "minimax", provider: "minimax" },
  "MiniMax-M2.5": { inputPer1M: 0.3, outputPer1M: 1.2, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25, priceSource: "minimax", vendor: "minimax", provider: "minimax" },
  "MiniMax-M2.5-highspeed": { inputPer1M: 0.6, outputPer1M: 2.4, cacheReadMultiplier: 0.05, cacheWriteMultiplier: 0.625, priceSource: "minimax", vendor: "minimax", provider: "minimax" },
  "MiniMax-M2.7": { inputPer1M: 0.3, outputPer1M: 1.2, cacheReadMultiplier: 0.2, cacheWriteMultiplier: 1.25, priceSource: "minimax", vendor: "minimax", provider: "minimax" },
  "MiniMax-M2.7-highspeed": { inputPer1M: 0.6, outputPer1M: 2.4, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 0.625, priceSource: "minimax", vendor: "minimax", provider: "minimax" },
  "MiniMax-M3": { inputPer1M: 0.3, outputPer1M: 1.2, cacheReadMultiplier: 0.2, tiers: [{ aboveInputTokens: 512000, inputPer1M: 0.6, outputPer1M: 2.4, cacheReadMultiplier: 0.2 }], priceSource: "minimax", vendor: "minimax", provider: "minimax" },
} as const

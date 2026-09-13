// GENERATED FILE — do not edit; regenerate with scripts/catalog-sync/sync-minimax.mjs
// (ids: committed PascalCase native list from catalog.ts, pricing: OpenRouter /v1/models (minimax/*), synced 2026-08-31T13:21:02.179Z)
// Normalization: lowercase → prepend "minimax-" when missing
// Known native ids: MiniMax-M2, M2-her, MiniMax-M2.1, MiniMax-M2.5, MiniMax-M2.7
//
// ⚠ cacheReadMultiplier is derived from OpenRouter's input_cache_read where
// present; OpenRouter's minimax/* routes carry NO input_cache_write field at
// all, for any id — cacheWriteMultiplier can never be derived from this
// source. See the PR body for the consequence on ids that had a manual
// cacheWriteMultiplier.

export const MINIMAX_GENERATED_PRICING = {
  "M2-her": { inputPer1M: 0.3, outputPer1M: 1.2, cacheReadMultiplier: 0.1, vendor: "minimax", provider: "minimax" },
  "MiniMax-M2": { inputPer1M: 0.255, outputPer1M: 1.02, vendor: "minimax", provider: "minimax" },
  "MiniMax-M2.1": { inputPer1M: 0.3, outputPer1M: 1.2, cacheReadMultiplier: 0.1, vendor: "minimax", provider: "minimax" },
  "MiniMax-M2.5": { inputPer1M: 0.27, outputPer1M: 1.08, cacheReadMultiplier: 0.1, vendor: "minimax", provider: "minimax" },
  "MiniMax-M2.7": { inputPer1M: 0.3, outputPer1M: 1.2, cacheReadMultiplier: 0.2, vendor: "minimax", provider: "minimax" },
} as const

// GENERATED FILE — do not edit; regenerate with scripts/catalog-sync/sync-xai.mjs (data: xAI /v1/models native pricing, synced 2026-08-31T12:39:30.344Z)
//
// Prices are xAI's NATIVE rates (no OpenRouter passthrough): raw
// `prompt_text_token_price` / `completion_text_token_price` /
// `cached_prompt_text_token_price` are per 1 token → $ per 1M = raw / 10000.
//
// ⚠ `longContext` (tier pricing above `thresholdTokens` tokens) is captured
// for reference only — the billing engine does NOT model long-context tiers
// yet (same gap as the Gemini >200k tiers: see `catalog.ts:172` and
// `catalog.ts:204`).

export interface XAIPricingEntry {
  /** $ per 1M input tokens (short-context tier). */
  inputPer1M: number
  /** $ per 1M output tokens (short-context tier). */
  outputPer1M: number
  /** $ per 1M cached input tokens. */
  cachedInputPer1M?: number
  /**
   * Long-context tier (prompts above `thresholdTokens`). CAPTURED BUT NOT
   * YET CONSUMED — the billing engine applies a single price regardless of
   * prompt size (see `catalog.ts:172`, `catalog.ts:204`).
   */
  longContext?: {
    inputPer1M: number
    outputPer1M: number
    cachedInputPer1M?: number
    thresholdTokens: number
  }
  /** Who authored the model (always "xai"). */
  vendor: "xai"
  /** Route used to call the model (always "xai" — direct SDK). */
  provider: "xai"
}

export const XAI_GENERATED_PRICING = {
  "grok-4.20-0309-non-reasoning": { inputPer1M: 1.25, outputPer1M: 2.5, cachedInputPer1M: 0.2, longContext: { inputPer1M: 2.5, outputPer1M: 5, cachedInputPer1M: 0.4, thresholdTokens: 200000 }, vendor: "xai", provider: "xai" },
  "grok-4.20-0309-reasoning": { inputPer1M: 1.25, outputPer1M: 2.5, cachedInputPer1M: 0.2, longContext: { inputPer1M: 2.5, outputPer1M: 5, cachedInputPer1M: 0.4, thresholdTokens: 200000 }, vendor: "xai", provider: "xai" },
  "grok-4.20-multi-agent-0309": { inputPer1M: 1.25, outputPer1M: 2.5, cachedInputPer1M: 0.2, longContext: { inputPer1M: 2.5, outputPer1M: 5, cachedInputPer1M: 0.4, thresholdTokens: 200000 }, vendor: "xai", provider: "xai" },
  "grok-4.3": { inputPer1M: 1.25, outputPer1M: 2.5, cachedInputPer1M: 0.2, longContext: { inputPer1M: 2.5, outputPer1M: 5, cachedInputPer1M: 0.4, thresholdTokens: 200000 }, vendor: "xai", provider: "xai" },
  "grok-4.5": { inputPer1M: 2, outputPer1M: 6, cachedInputPer1M: 0.3, longContext: { inputPer1M: 4, outputPer1M: 12, cachedInputPer1M: 0.6, thresholdTokens: 200000 }, vendor: "xai", provider: "xai" },
  "grok-4.6": { inputPer1M: 2, outputPer1M: 6, cachedInputPer1M: 0.5, longContext: { inputPer1M: 4, outputPer1M: 12, cachedInputPer1M: 1, thresholdTokens: 200000 }, vendor: "xai", provider: "xai" },
  "grok-build-0.1": { inputPer1M: 1, outputPer1M: 2, cachedInputPer1M: 0.2, longContext: { inputPer1M: 2, outputPer1M: 4, cachedInputPer1M: 0.4, thresholdTokens: 200000 }, vendor: "xai", provider: "xai" },
} as const satisfies Record<string, XAIPricingEntry>

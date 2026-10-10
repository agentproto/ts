// GENERATED FILE — do not edit; regenerate with scripts/catalog-sync/sync-xai.mjs (data: llm-xai.json snapshot (xAI API fetch failed), synced 2026-10-10T01:18:24.649Z)
//
// Prices are xAI's NATIVE rates (no OpenRouter passthrough): raw
// `prompt_text_token_price` / `completion_text_token_price` /
// `cached_prompt_text_token_price` are per 1 token → $ per 1M = raw / 10000.
// The cached price is emitted as `cacheReadMultiplier` (cached / input) and
// the long-context price (prompts over `long_context_threshold`) as `tiers`.

import type { LLMPricingTier } from "./catalog.js"

export interface XAIPricingEntry {
  /** $ per 1M input tokens (short-context tier). */
  inputPer1M: number
  /** $ per 1M output tokens (short-context tier). */
  outputPer1M: number
  /** Cached-input price as a multiplier on `inputPer1M`. */
  cacheReadMultiplier?: number
  /** Long-context tier: prompts over `aboveInputTokens` bill at these rates. */
  tiers?: readonly LLMPricingTier[]
  /** Who authored the model (always "xai"). */
  vendor: "xai"
  /** Route used to call the model (always "xai" — direct SDK). */
  provider: "xai"
}

export const XAI_GENERATED_PRICING = {
  "grok-4.20": { inputPer1M: 1.25, outputPer1M: 2.5, cacheReadMultiplier: 0.16, tiers: [{ aboveInputTokens: 200000, inputPer1M: 2.5, outputPer1M: 5, cacheReadMultiplier: 0.16 }], vendor: "xai", provider: "xai" },
  "grok-4.20-0309": { inputPer1M: 1.25, outputPer1M: 2.5, cacheReadMultiplier: 0.16, tiers: [{ aboveInputTokens: 200000, inputPer1M: 2.5, outputPer1M: 5, cacheReadMultiplier: 0.16 }], vendor: "xai", provider: "xai" },
  "grok-4.20-0309-non-reasoning": { inputPer1M: 1.25, outputPer1M: 2.5, cacheReadMultiplier: 0.16, tiers: [{ aboveInputTokens: 200000, inputPer1M: 2.5, outputPer1M: 5, cacheReadMultiplier: 0.16 }], vendor: "xai", provider: "xai" },
  "grok-4.20-0309-reasoning": { inputPer1M: 1.25, outputPer1M: 2.5, cacheReadMultiplier: 0.16, tiers: [{ aboveInputTokens: 200000, inputPer1M: 2.5, outputPer1M: 5, cacheReadMultiplier: 0.16 }], vendor: "xai", provider: "xai" },
  "grok-4.20-beta": { inputPer1M: 1.25, outputPer1M: 2.5, cacheReadMultiplier: 0.16, tiers: [{ aboveInputTokens: 200000, inputPer1M: 2.5, outputPer1M: 5, cacheReadMultiplier: 0.16 }], vendor: "xai", provider: "xai" },
  "grok-4.20-beta-0309": { inputPer1M: 1.25, outputPer1M: 2.5, cacheReadMultiplier: 0.16, tiers: [{ aboveInputTokens: 200000, inputPer1M: 2.5, outputPer1M: 5, cacheReadMultiplier: 0.16 }], vendor: "xai", provider: "xai" },
  "grok-4.20-beta-0309-non-reasoning": { inputPer1M: 1.25, outputPer1M: 2.5, cacheReadMultiplier: 0.16, tiers: [{ aboveInputTokens: 200000, inputPer1M: 2.5, outputPer1M: 5, cacheReadMultiplier: 0.16 }], vendor: "xai", provider: "xai" },
  "grok-4.20-beta-0309-reasoning": { inputPer1M: 1.25, outputPer1M: 2.5, cacheReadMultiplier: 0.16, tiers: [{ aboveInputTokens: 200000, inputPer1M: 2.5, outputPer1M: 5, cacheReadMultiplier: 0.16 }], vendor: "xai", provider: "xai" },
  "grok-4.20-beta-latest": { inputPer1M: 1.25, outputPer1M: 2.5, cacheReadMultiplier: 0.16, tiers: [{ aboveInputTokens: 200000, inputPer1M: 2.5, outputPer1M: 5, cacheReadMultiplier: 0.16 }], vendor: "xai", provider: "xai" },
  "grok-4.20-beta-latest-non-reasoning": { inputPer1M: 1.25, outputPer1M: 2.5, cacheReadMultiplier: 0.16, tiers: [{ aboveInputTokens: 200000, inputPer1M: 2.5, outputPer1M: 5, cacheReadMultiplier: 0.16 }], vendor: "xai", provider: "xai" },
  "grok-4.20-beta-latest-reasoning": { inputPer1M: 1.25, outputPer1M: 2.5, cacheReadMultiplier: 0.16, tiers: [{ aboveInputTokens: 200000, inputPer1M: 2.5, outputPer1M: 5, cacheReadMultiplier: 0.16 }], vendor: "xai", provider: "xai" },
  "grok-4.20-beta-non-reasoning": { inputPer1M: 1.25, outputPer1M: 2.5, cacheReadMultiplier: 0.16, tiers: [{ aboveInputTokens: 200000, inputPer1M: 2.5, outputPer1M: 5, cacheReadMultiplier: 0.16 }], vendor: "xai", provider: "xai" },
  "grok-4.20-beta-reasoning": { inputPer1M: 1.25, outputPer1M: 2.5, cacheReadMultiplier: 0.16, tiers: [{ aboveInputTokens: 200000, inputPer1M: 2.5, outputPer1M: 5, cacheReadMultiplier: 0.16 }], vendor: "xai", provider: "xai" },
  "grok-4.20-experimental-beta-0304": { inputPer1M: 1.25, outputPer1M: 2.5, cacheReadMultiplier: 0.16, tiers: [{ aboveInputTokens: 200000, inputPer1M: 2.5, outputPer1M: 5, cacheReadMultiplier: 0.16 }], vendor: "xai", provider: "xai" },
  "grok-4.20-experimental-beta-0304-non-reasoning": { inputPer1M: 1.25, outputPer1M: 2.5, cacheReadMultiplier: 0.16, tiers: [{ aboveInputTokens: 200000, inputPer1M: 2.5, outputPer1M: 5, cacheReadMultiplier: 0.16 }], vendor: "xai", provider: "xai" },
  "grok-4.20-experimental-beta-0304-reasoning": { inputPer1M: 1.25, outputPer1M: 2.5, cacheReadMultiplier: 0.16, tiers: [{ aboveInputTokens: 200000, inputPer1M: 2.5, outputPer1M: 5, cacheReadMultiplier: 0.16 }], vendor: "xai", provider: "xai" },
  "grok-4.20-experimental-beta-latest": { inputPer1M: 1.25, outputPer1M: 2.5, cacheReadMultiplier: 0.16, tiers: [{ aboveInputTokens: 200000, inputPer1M: 2.5, outputPer1M: 5, cacheReadMultiplier: 0.16 }], vendor: "xai", provider: "xai" },
  "grok-4.20-experimental-beta-non-reasoning-latest": { inputPer1M: 1.25, outputPer1M: 2.5, cacheReadMultiplier: 0.16, tiers: [{ aboveInputTokens: 200000, inputPer1M: 2.5, outputPer1M: 5, cacheReadMultiplier: 0.16 }], vendor: "xai", provider: "xai" },
  "grok-4.20-experimental-beta-reasoning-latest": { inputPer1M: 1.25, outputPer1M: 2.5, cacheReadMultiplier: 0.16, tiers: [{ aboveInputTokens: 200000, inputPer1M: 2.5, outputPer1M: 5, cacheReadMultiplier: 0.16 }], vendor: "xai", provider: "xai" },
  "grok-4.20-multi-agent": { inputPer1M: 1.25, outputPer1M: 2.5, cacheReadMultiplier: 0.16, tiers: [{ aboveInputTokens: 200000, inputPer1M: 2.5, outputPer1M: 5, cacheReadMultiplier: 0.16 }], vendor: "xai", provider: "xai" },
  "grok-4.20-multi-agent-0309": { inputPer1M: 1.25, outputPer1M: 2.5, cacheReadMultiplier: 0.16, tiers: [{ aboveInputTokens: 200000, inputPer1M: 2.5, outputPer1M: 5, cacheReadMultiplier: 0.16 }], vendor: "xai", provider: "xai" },
  "grok-4.20-multi-agent-beta-0309": { inputPer1M: 1.25, outputPer1M: 2.5, cacheReadMultiplier: 0.16, tiers: [{ aboveInputTokens: 200000, inputPer1M: 2.5, outputPer1M: 5, cacheReadMultiplier: 0.16 }], vendor: "xai", provider: "xai" },
  "grok-4.20-multi-agent-beta-latest": { inputPer1M: 1.25, outputPer1M: 2.5, cacheReadMultiplier: 0.16, tiers: [{ aboveInputTokens: 200000, inputPer1M: 2.5, outputPer1M: 5, cacheReadMultiplier: 0.16 }], vendor: "xai", provider: "xai" },
  "grok-4.20-multi-agent-experimental-beta-0304": { inputPer1M: 1.25, outputPer1M: 2.5, cacheReadMultiplier: 0.16, tiers: [{ aboveInputTokens: 200000, inputPer1M: 2.5, outputPer1M: 5, cacheReadMultiplier: 0.16 }], vendor: "xai", provider: "xai" },
  "grok-4.20-multi-agent-experimental-beta-latest": { inputPer1M: 1.25, outputPer1M: 2.5, cacheReadMultiplier: 0.16, tiers: [{ aboveInputTokens: 200000, inputPer1M: 2.5, outputPer1M: 5, cacheReadMultiplier: 0.16 }], vendor: "xai", provider: "xai" },
  "grok-4.20-multi-agent-latest": { inputPer1M: 1.25, outputPer1M: 2.5, cacheReadMultiplier: 0.16, tiers: [{ aboveInputTokens: 200000, inputPer1M: 2.5, outputPer1M: 5, cacheReadMultiplier: 0.16 }], vendor: "xai", provider: "xai" },
  "grok-4.20-non-reasoning": { inputPer1M: 1.25, outputPer1M: 2.5, cacheReadMultiplier: 0.16, tiers: [{ aboveInputTokens: 200000, inputPer1M: 2.5, outputPer1M: 5, cacheReadMultiplier: 0.16 }], vendor: "xai", provider: "xai" },
  "grok-4.20-non-reasoning-gv2": { inputPer1M: 1.25, outputPer1M: 2.5, cacheReadMultiplier: 0.16, tiers: [{ aboveInputTokens: 200000, inputPer1M: 2.5, outputPer1M: 5, cacheReadMultiplier: 0.16 }], vendor: "xai", provider: "xai" },
  "grok-4.20-non-reasoning-latest": { inputPer1M: 1.25, outputPer1M: 2.5, cacheReadMultiplier: 0.16, tiers: [{ aboveInputTokens: 200000, inputPer1M: 2.5, outputPer1M: 5, cacheReadMultiplier: 0.16 }], vendor: "xai", provider: "xai" },
  "grok-4.20-reasoning": { inputPer1M: 1.25, outputPer1M: 2.5, cacheReadMultiplier: 0.16, tiers: [{ aboveInputTokens: 200000, inputPer1M: 2.5, outputPer1M: 5, cacheReadMultiplier: 0.16 }], vendor: "xai", provider: "xai" },
  "grok-4.20-reasoning-gv2": { inputPer1M: 1.25, outputPer1M: 2.5, cacheReadMultiplier: 0.16, tiers: [{ aboveInputTokens: 200000, inputPer1M: 2.5, outputPer1M: 5, cacheReadMultiplier: 0.16 }], vendor: "xai", provider: "xai" },
  "grok-4.20-reasoning-latest": { inputPer1M: 1.25, outputPer1M: 2.5, cacheReadMultiplier: 0.16, tiers: [{ aboveInputTokens: 200000, inputPer1M: 2.5, outputPer1M: 5, cacheReadMultiplier: 0.16 }], vendor: "xai", provider: "xai" },
  "grok-4.3": { inputPer1M: 1.25, outputPer1M: 2.5, cacheReadMultiplier: 0.16, tiers: [{ aboveInputTokens: 200000, inputPer1M: 2.5, outputPer1M: 5, cacheReadMultiplier: 0.16 }], vendor: "xai", provider: "xai" },
  "grok-4.3-latest": { inputPer1M: 1.25, outputPer1M: 2.5, cacheReadMultiplier: 0.16, tiers: [{ aboveInputTokens: 200000, inputPer1M: 2.5, outputPer1M: 5, cacheReadMultiplier: 0.16 }], vendor: "xai", provider: "xai" },
  "grok-4.5": { inputPer1M: 2, outputPer1M: 6, cacheReadMultiplier: 0.15, tiers: [{ aboveInputTokens: 200000, inputPer1M: 4, outputPer1M: 12, cacheReadMultiplier: 0.15 }], vendor: "xai", provider: "xai" },
  "grok-4.5-latest": { inputPer1M: 2, outputPer1M: 6, cacheReadMultiplier: 0.15, tiers: [{ aboveInputTokens: 200000, inputPer1M: 4, outputPer1M: 12, cacheReadMultiplier: 0.15 }], vendor: "xai", provider: "xai" },
  "grok-4.6": { inputPer1M: 2, outputPer1M: 6, cacheReadMultiplier: 0.25, tiers: [{ aboveInputTokens: 200000, inputPer1M: 4, outputPer1M: 12, cacheReadMultiplier: 0.25 }], vendor: "xai", provider: "xai" },
  "grok-4.7": { inputPer1M: 2, outputPer1M: 6, cacheReadMultiplier: 0.25, tiers: [{ aboveInputTokens: 200000, inputPer1M: 4, outputPer1M: 12, cacheReadMultiplier: 0.25 }], vendor: "xai", provider: "xai" },
  "grok-build-0.1": { inputPer1M: 1, outputPer1M: 2, cacheReadMultiplier: 0.2, tiers: [{ aboveInputTokens: 200000, inputPer1M: 2, outputPer1M: 4, cacheReadMultiplier: 0.2 }], vendor: "xai", provider: "xai" },
  "grok-build-latest": { inputPer1M: 2, outputPer1M: 6, cacheReadMultiplier: 0.15, tiers: [{ aboveInputTokens: 200000, inputPer1M: 4, outputPer1M: 12, cacheReadMultiplier: 0.15 }], vendor: "xai", provider: "xai" },
  "grok-code-fast": { inputPer1M: 1, outputPer1M: 2, cacheReadMultiplier: 0.2, tiers: [{ aboveInputTokens: 200000, inputPer1M: 2, outputPer1M: 4, cacheReadMultiplier: 0.2 }], vendor: "xai", provider: "xai" },
  "grok-code-fast-1": { inputPer1M: 1, outputPer1M: 2, cacheReadMultiplier: 0.2, tiers: [{ aboveInputTokens: 200000, inputPer1M: 2, outputPer1M: 4, cacheReadMultiplier: 0.2 }], vendor: "xai", provider: "xai" },
  "grok-code-fast-1-0825": { inputPer1M: 1, outputPer1M: 2, cacheReadMultiplier: 0.2, tiers: [{ aboveInputTokens: 200000, inputPer1M: 2, outputPer1M: 4, cacheReadMultiplier: 0.2 }], vendor: "xai", provider: "xai" },
} as const satisfies Record<string, XAIPricingEntry>

// GENERATED FILE — do not edit; regenerate with scripts/catalog-sync/sync-copilot.mjs
// (ids + pricing: github/docs data/tables/copilot/models-and-pricing.yml + the
// promo footnotes of models-and-pricing.md, i.e. GitHub Copilot's own price list;
// ids are Copilot's spelling, e.g. dotted "claude-sonnet-5.5". synced 2026-11-23T16:49:01.654Z)
// `promo`: the row carries the PROMOTIONAL price; `promo.then` is the standard
// price from `promo.until` on (see effectivePricing in catalog.ts).

export const COPILOT_GENERATED_PRICING = {
  "claude-fable-5": { inputPer1M: 10, outputPer1M: 50, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25, priceSource: "github-copilot", vendor: "anthropic" },
  "claude-fable-5.1": { inputPer1M: 10, outputPer1M: 50, cacheReadMultiplier: 0.025, cacheWriteMultiplier: 1.25, priceSource: "github-copilot", vendor: "anthropic" },
  "claude-fable-5.2": { inputPer1M: 8, outputPer1M: 40, cacheReadMultiplier: 0.025, cacheWriteMultiplier: 1.25, priceSource: "github-copilot", vendor: "anthropic" },
  "claude-haiku-4.5": { inputPer1M: 1, outputPer1M: 5, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25, priceSource: "github-copilot", vendor: "anthropic" },
  "claude-haiku-5.5": { inputPer1M: 0.1, outputPer1M: 0.5, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25, tiers: [{ aboveInputTokens: 100000, inputPer1M: 0.5, outputPer1M: 2.5, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25 }], priceSource: "github-copilot", vendor: "anthropic" },
  "claude-opus-4.8": { inputPer1M: 5, outputPer1M: 25, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25, priceSource: "github-copilot", vendor: "anthropic" },
  "claude-opus-5.5": { inputPer1M: 4, outputPer1M: 20, cacheReadMultiplier: 0.05, cacheWriteMultiplier: 1.25, priceSource: "github-copilot", vendor: "anthropic" },
  "claude-sonnet-4": { inputPer1M: 3, outputPer1M: 15, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25, priceSource: "github-copilot", vendor: "anthropic" },
  "claude-sonnet-4.6": { inputPer1M: 3, outputPer1M: 15, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25, priceSource: "github-copilot", vendor: "anthropic" },
  "claude-sonnet-5": { inputPer1M: 2, outputPer1M: 10, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25, priceSource: "github-copilot", vendor: "anthropic" },
  "claude-sonnet-5.5": { inputPer1M: 2, outputPer1M: 10, cacheReadMultiplier: 0.05, cacheWriteMultiplier: 1.25, priceSource: "github-copilot", vendor: "anthropic" },
  "gemini-3.8-flash": { inputPer1M: 0.75, outputPer1M: 3.75, cacheReadMultiplier: 0.1, promo: { until: "2026-12-31" }, priceSource: "github-copilot", vendor: "google" },
  "gemini-4-argon": { inputPer1M: 2, outputPer1M: 10, cacheReadMultiplier: 0.05, promo: { until: "2026-12-01" }, priceSource: "github-copilot", vendor: "google" },
  "gemini-4-carbon": { inputPer1M: 2, outputPer1M: 10, cacheReadMultiplier: 0.05, promo: { until: "2026-12-01", then: { inputPer1M: 4, outputPer1M: 20, cacheReadMultiplier: 0.05 } }, priceSource: "github-copilot", vendor: "google" },
  "gemini-4-hydrogen": { inputPer1M: 1.5, outputPer1M: 7.5, cacheReadMultiplier: 0.05, priceSource: "github-copilot", vendor: "google" },
  "gemini-4-neon": { inputPer1M: 3, outputPer1M: 15, cacheReadMultiplier: 0.05, priceSource: "github-copilot", vendor: "google" },
  "gpt-5.3-codex": { inputPer1M: 1.75, outputPer1M: 14, cacheReadMultiplier: 0.1, priceSource: "github-copilot", vendor: "openai" },
  "gpt-5.4-nano": { inputPer1M: 0.2, outputPer1M: 1.25, cacheReadMultiplier: 0.1, priceSource: "github-copilot", vendor: "openai" },
  "gpt-5.6-luna": { inputPer1M: 0.2, outputPer1M: 1.2, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25, tiers: [{ aboveInputTokens: 200000, inputPer1M: 0.4, outputPer1M: 1.8, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25 }], priceSource: "github-copilot", vendor: "openai" },
  "gpt-5.6-sol": { inputPer1M: 4, outputPer1M: 20, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25, tiers: [{ aboveInputTokens: 272000, inputPer1M: 8, outputPer1M: 30, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25 }], priceSource: "github-copilot", vendor: "openai" },
  "gpt-6-astra": { inputPer1M: 10, outputPer1M: 50, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25, tiers: [{ aboveInputTokens: 272000, inputPer1M: 20, outputPer1M: 75, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25 }], priceSource: "github-copilot", vendor: "openai" },
  "gpt-6-luna": { inputPer1M: 0.1, outputPer1M: 0.5, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25, tiers: [{ aboveInputTokens: 272000, inputPer1M: 0.2, outputPer1M: 0.75, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25 }], priceSource: "github-copilot", vendor: "openai" },
  "gpt-6-sol": { inputPer1M: 2, outputPer1M: 10, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25, tiers: [{ aboveInputTokens: 272000, inputPer1M: 4, outputPer1M: 15, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25 }], priceSource: "github-copilot", vendor: "openai" },
  "gpt-6.1-sol": { inputPer1M: 2, outputPer1M: 10, cacheReadMultiplier: 0.05, cacheWriteMultiplier: 1.25, tiers: [{ aboveInputTokens: 272000, inputPer1M: 4, outputPer1M: 15, cacheReadMultiplier: 0.05, cacheWriteMultiplier: 1.25 }], priceSource: "github-copilot", vendor: "openai" },
  "gpt-6.1-terra": { inputPer1M: 1, outputPer1M: 5, cacheReadMultiplier: 0.05, cacheWriteMultiplier: 1.25, tiers: [{ aboveInputTokens: 272000, inputPer1M: 2, outputPer1M: 7.5, cacheReadMultiplier: 0.05, cacheWriteMultiplier: 1.25 }], priceSource: "github-copilot", vendor: "openai" },
  "gpt-6.2-astra": { inputPer1M: 8, outputPer1M: 40, cacheReadMultiplier: 0.05, cacheWriteMultiplier: 1.25, tiers: [{ aboveInputTokens: 272000, inputPer1M: 16, outputPer1M: 60, cacheReadMultiplier: 0.05, cacheWriteMultiplier: 1.25 }], priceSource: "github-copilot", vendor: "openai" },
  "gpt-6.2-sol": { inputPer1M: 2, outputPer1M: 10, cacheReadMultiplier: 0.05, cacheWriteMultiplier: 1.25, tiers: [{ aboveInputTokens: 272000, inputPer1M: 4, outputPer1M: 15, cacheReadMultiplier: 0.05, cacheWriteMultiplier: 1.25 }], priceSource: "github-copilot", vendor: "openai" },
  "grok-4.5": { inputPer1M: 2, outputPer1M: 6, cacheReadMultiplier: 0.25, tiers: [{ aboveInputTokens: 200000, inputPer1M: 4, outputPer1M: 12, cacheReadMultiplier: 0.25 }], priceSource: "github-copilot", vendor: "xai" },
  "grok-4.6": { inputPer1M: 2, outputPer1M: 6, cacheReadMultiplier: 0.25, tiers: [{ aboveInputTokens: 200000, inputPer1M: 4, outputPer1M: 12, cacheReadMultiplier: 0.25 }], priceSource: "github-copilot", vendor: "xai" },
  "grok-4.7": { inputPer1M: 2, outputPer1M: 6, cacheReadMultiplier: 0.25, tiers: [{ aboveInputTokens: 200000, inputPer1M: 4, outputPer1M: 12, cacheReadMultiplier: 0.25 }], priceSource: "github-copilot", vendor: "xai" },
  "kimi-k3": { inputPer1M: 3, outputPer1M: 15, cacheReadMultiplier: 0.1, priceSource: "github-copilot", vendor: "moonshot" },
  "mai-code-1.1-flash": { inputPer1M: 0.2, outputPer1M: 1.2, cacheReadMultiplier: 0.1, priceSource: "github-copilot", vendor: "microsoft" },
  "mai-code-2": { inputPer1M: 0.5, outputPer1M: 2.5, cacheReadMultiplier: 0.05, promo: { until: "2027-05-17", then: { inputPer1M: 1, outputPer1M: 5, cacheReadMultiplier: 0.05 } }, priceSource: "github-copilot", vendor: "microsoft" },
  "mai-code-2-flash": { inputPer1M: 0.05, outputPer1M: 0.25, cacheReadMultiplier: 0.1, promo: { until: "2027-05-17", then: { inputPer1M: 0.1, outputPer1M: 0.5, cacheReadMultiplier: 0.1 } }, priceSource: "github-copilot", vendor: "microsoft" },
} as const

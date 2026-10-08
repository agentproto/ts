/**
 * One xAI `/v1/models` row → a catalog pricing row, in the catalog's billed
 * shape.
 *
 * Plain JS (types in `xai-pricing.d.mts`) so the bare-`node` sync script
 * (`scripts/catalog-sync/sync-xai.mjs`) and the tests share it.
 *
 * xAI publishes NATIVE prices per 1 token in units of 1/10000 $ per 1M
 * (`prompt_text_token_price: 12500` = $1.25/1M). The cached price becomes
 * `cacheReadMultiplier` (cached / input) and the long-context prices
 * (prompts over `long_context_threshold`) a prompt-length `tiers` entry —
 * the fields `calculateLLMCreditCost` / `selectPricingTier` read.
 */

/** Raw prices are per 1 token; catalog prices are $ per 1M tokens. */
const PER_1M = 10_000

function round4(n) {
  return Math.round(n * 10_000) / 10_000
}

function round6(n) {
  return Math.round(n * 1_000_000) / 1_000_000
}

/** `cached / input` as a multiplier, or undefined when either is missing. */
function cacheRatio(rawCached, inputPer1M) {
  if (rawCached == null || !(inputPer1M > 0)) return undefined
  return round6(rawCached / PER_1M / inputPer1M)
}

/**
 * @param {Record<string, unknown>} m one `/v1/models` row
 * @returns {import("./xai-pricing.d.mts").XaiPricingRow | undefined}
 *   undefined for a non-text / unpriced model (`grok-imagine-*`).
 */
export function xaiPricingRow(m) {
  if (
    !m.id ||
    m.context_length == null ||
    m.prompt_text_token_price == null ||
    m.completion_text_token_price == null
  ) {
    return undefined
  }
  const row = {
    id: m.id,
    inputPer1M: round4(m.prompt_text_token_price / PER_1M),
    outputPer1M: round4(m.completion_text_token_price / PER_1M),
  }
  const cacheRead = cacheRatio(m.cached_prompt_text_token_price, row.inputPer1M)
  if (cacheRead !== undefined) row.cacheReadMultiplier = cacheRead
  if (
    m.prompt_text_token_price_long_context != null &&
    m.completion_text_token_price_long_context != null &&
    m.long_context_threshold != null
  ) {
    const tier = {
      aboveInputTokens: m.long_context_threshold,
      inputPer1M: round4(m.prompt_text_token_price_long_context / PER_1M),
      outputPer1M: round4(m.completion_text_token_price_long_context / PER_1M),
    }
    const tierCacheRead = cacheRatio(m.cached_prompt_text_token_price_long_context, tier.inputPer1M)
    if (tierCacheRead !== undefined) tier.cacheReadMultiplier = tierCacheRead
    row.tiers = [tier]
  }
  return row
}

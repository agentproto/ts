/**
 * Prompt-length price tiers from an OpenRouter `pricing` block.
 *
 * Plain JS (types in `openrouter-prompt-tiers.d.mts`) so both the TS
 * `llm:openrouter` generator and the bare-`node` native sync scripts
 * (`scripts/catalog-sync/sync-anthropic.mjs`) derive tiers the same way.
 *
 * OpenRouter publishes a model's non-base prices as `pricing.overrides[]`.
 * Two unrelated kinds share that array:
 *   - prompt-length tiers: `{ min_prompt_tokens: 100000, prompt, completion,
 *     input_cache_read?, input_cache_write? }` — e.g. Claude Haiku 5.5, 5x
 *     over 100k tokens (matches platform.claude.com/docs/en/about-claude/pricing,
 *     checked 2026-10-08).
 *   - time-of-day discounts: `{ utc_start, utc_end, utc_days?, … }` (DeepSeek,
 *     Tencent off-peak). NOT a prompt-length tier — ignored here.
 * Only overrides keyed SOLELY on `min_prompt_tokens` become tiers.
 *
 * `min_prompt_tokens` maps to `aboveInputTokens` as-is; a prompt of exactly
 * the threshold lands in the base tier (Anthropic: "prompts over 100,000
 * tokens"). Cache ratios are relative to the TIER's own prompt price and
 * omitted when the override doesn't carry them (the catalog then inherits
 * the base multiplier).
 */

function round6(n) {
  return Math.round(n * 1_000_000) / 1_000_000
}

function per1m(tokenPrice) {
  if (tokenPrice === undefined || tokenPrice === null) return undefined
  const n = Number(tokenPrice)
  return Number.isFinite(n) ? round6(n * 1_000_000) : undefined
}

/**
 * @param {Record<string, unknown> | undefined} pricing OpenRouter `pricing`
 * @returns {import("./openrouter-prompt-tiers.d.mts").PromptLengthTier[] | undefined}
 *   ascending by `aboveInputTokens`, or undefined when the model has none.
 */
export function promptLengthTiers(pricing) {
  const overrides = pricing?.overrides
  if (!Array.isArray(overrides)) return undefined
  const byThreshold = new Map()
  for (const o of overrides) {
    if (!o || typeof o !== "object") continue
    if (typeof o.min_prompt_tokens !== "number" || !(o.min_prompt_tokens > 0)) continue
    if (Object.keys(o).some((k) => k.startsWith("utc_"))) continue
    const inputPer1M = per1m(o.prompt)
    const outputPer1M = per1m(o.completion)
    if (inputPer1M === undefined || outputPer1M === undefined) continue
    const tier = { aboveInputTokens: o.min_prompt_tokens, inputPer1M, outputPer1M }
    const cacheRead = per1m(o.input_cache_read)
    const cacheWrite = per1m(o.input_cache_write)
    if (cacheRead !== undefined && cacheRead > 0 && inputPer1M > 0) {
      tier.cacheReadMultiplier = round6(cacheRead / inputPer1M)
    }
    if (cacheWrite !== undefined && cacheWrite > 0 && inputPer1M > 0) {
      tier.cacheWriteMultiplier = round6(cacheWrite / inputPer1M)
    }
    byThreshold.set(tier.aboveInputTokens, tier)
  }
  if (byThreshold.size === 0) return undefined
  return [...byThreshold.values()].sort((a, b) => a.aboveInputTokens - b.aboveInputTokens)
}

/**
 * Render tiers as a TS object-literal field for a generated pricing row:
 * `tiers: [{ aboveInputTokens: 100000, inputPer1M: 0.5, outputPer1M: 2.5 }]`.
 *
 * @param {import("./openrouter-prompt-tiers.d.mts").PromptLengthTier[]} tiers
 */
export function serializeTiers(tiers) {
  const items = tiers.map((t) => {
    const fields = [
      `aboveInputTokens: ${t.aboveInputTokens}`,
      `inputPer1M: ${t.inputPer1M}`,
      `outputPer1M: ${t.outputPer1M}`,
    ]
    if (t.cacheReadMultiplier !== undefined) fields.push(`cacheReadMultiplier: ${t.cacheReadMultiplier}`)
    if (t.cacheWriteMultiplier !== undefined) fields.push(`cacheWriteMultiplier: ${t.cacheWriteMultiplier}`)
    return `{ ${fields.join(", ")} }`
  })
  return `tiers: [${items.join(", ")}]`
}

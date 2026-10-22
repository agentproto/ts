/**
 * First-party provider pricing from models.dev's `api.json` (keyless).
 *
 * WHY: the vendor pricing pages are the ideal source, but their markup is not
 * a contract — on 2026-10-21 platform.kimi.ai's `.md` rendering started
 * emitting empty `<table>` shells (the rows only exist in the page's RSC
 * payload), so `parseKimiPricingPage` returned zero rows and `sync-moonshot`
 * silently fell back to OpenRouter. That replaced Moonshot's $3 / $15 for
 * kimi-k3 with OpenRouter's $0.239 / $11.936 under the same bare id, and the
 * hardcoded native-pricing test caught it. models.dev publishes the provider's
 * own rates (same numbers as Moonshot's page) behind a stable JSON endpoint,
 * so it is the secondary first-party source before degrading to OpenRouter.
 *
 * `api.json` is `{ [providerId]: { models: { [id]: { cost } } } }`, with
 * `cost` in USD per 1M tokens (`input`, `output`, optional `cache_read` /
 * `cache_write`).
 */

function round6(n) {
  return Math.round(n * 1_000_000) / 1_000_000
}

/**
 * @param {unknown} payload the parsed `https://models.dev/api.json`
 * @param {string} providerId e.g. `moonshotai`
 * @returns {Map<string, import("./models-dev-pricing.d.mts").ModelsDevPrice>}
 */
export function parseModelsDevProviderPricing(payload, providerId) {
  const prices = new Map()
  const models = payload?.[providerId]?.models
  if (!models || typeof models !== "object") return prices

  for (const [id, model] of Object.entries(models)) {
    const cost = model?.cost
    const inputPer1M = cost?.input
    const outputPer1M = cost?.output
    if (typeof inputPer1M !== "number" || typeof outputPer1M !== "number") continue
    if (!Number.isFinite(inputPer1M) || !Number.isFinite(outputPer1M)) continue

    const price = { inputPer1M, outputPer1M }
    if (inputPer1M > 0) {
      const cacheRead = cost.cache_read
      if (typeof cacheRead === "number" && Number.isFinite(cacheRead)) price.cacheReadMultiplier = round6(cacheRead / inputPer1M)
      const cacheWrite = cost.cache_write
      if (typeof cacheWrite === "number" && Number.isFinite(cacheWrite)) price.cacheWriteMultiplier = round6(cacheWrite / inputPer1M)
    }
    prices.set(id, price)
  }
  return prices
}

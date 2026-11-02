/**
 * Replicate public model page pricing, parsed from the JSON payload Replicate
 * embeds in each model page (`<script type="application/json">`).
 *
 * WHY: the Replicate HTTP API needs a token, but every public model page
 * embeds the same billing data anonymously:
 *
 *   "billingConfig": { "current_tiers": [{ "prices": [{
 *      "metric": "image_output_count", "price": "$3",
 *      "title": "per thousand output images", "type": "per-unit"
 *   }] }] },
 *   "price": "$0.001525 per second",
 *   "p50price": "$0.0048"
 *
 * `billingConfig` may be null for hardware-billed models - those expose only
 * the top-level per-second hardware rate (plus `p50price`, the median run
 * cost). The page markup is not a contract, so a missing/changed payload
 * throws a clear error; the sync then keeps the last committed price instead
 * of writing a wrong one.
 *
 * Plain JS (types in `replicate-model-page.d.mts`) so the bare-`node` sync
 * script and the vitest suite share it.
 */

const SCRIPT_RE = /<script[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/g

/** Unit + divisor for each Replicate billing metric we know how to express. */
const METRICS = {
  image_output_count: { unit: "per_image", divisorFromTitle: true },
  video_output_duration_seconds: { unit: "per_second" },
  audio_output_duration_seconds: { unit: "per_second" },
  output_token_count: { unit: "per_token" },
  text_output_token_count: { unit: "per_token" },
  input_token_count: { unit: "per_token" },
  text_input_characters: { unit: "per_1k_chars", divisorFromTitle: true },
  audio_output_minutes: { unit: "per_minute" },
}

/** First "$X" amount in a string, or undefined. */
function moneyOf(raw) {
  if (typeof raw !== "string") return undefined
  const m = /\$\s*([\d.]+)/.exec(raw)
  if (!m) return undefined
  const n = Number(m[1])
  return Number.isFinite(n) ? n : undefined
}

/** Round away binary-float noise from e.g. "$3 per thousand" / 1000. */
function round9(n) {
  return Math.round(n * 1_000_000_000) / 1_000_000_000
}

/**
 * Find the embedded model payload. There can be several JSON script tags on a
 * page; the billing one carries `model` plus either `billingConfig` or `price`.
 */
function findModelPayload(html) {
  if (typeof html !== "string" || html.length === 0) {
    throw new Error("Replicate model page: empty HTML")
  }
  SCRIPT_RE.lastIndex = 0
  let match
  while ((match = SCRIPT_RE.exec(html)) !== null) {
    let parsed
    try {
      parsed = JSON.parse(match[1])
    } catch {
      continue
    }
    if (
      parsed &&
      typeof parsed === "object" &&
      parsed.model &&
      typeof parsed.model.owner === "string" &&
      typeof parsed.model.name === "string" &&
      ("billingConfig" in parsed || "price" in parsed)
    ) {
      return parsed
    }
  }
  throw new Error(
    "Replicate model page: no embedded model JSON with billing data found - page shape changed"
  )
}

/** Top-level `price` string → `{ raw, amount, unit }`, or null. */
function parseTopLevelPrice(raw) {
  const amount = moneyOf(raw)
  if (amount === undefined || typeof raw !== "string") return null
  let unit
  if (/per\s+second/i.test(raw)) unit = "per_second"
  else if (/per\s+minute/i.test(raw)) unit = "per_minute"
  else if (/per\s+image/i.test(raw)) unit = "per_image"
  else if (/per\s+token/i.test(raw)) unit = "per_token"
  return { raw, amount, ...(unit ? { unit } : {}) }
}

/** Normalize `billingConfig.current_tiers[].prices[]` into priced rows. */
function tierPricesOf(billingConfig) {
  const out = []
  const tiers = billingConfig?.current_tiers
  if (!Array.isArray(tiers)) return out
  for (const tier of tiers) {
    const prices = tier?.prices
    if (!Array.isArray(prices)) continue
    for (const price of prices) {
      const metric = price?.metric
      const spec = METRICS[metric]
      if (!spec) continue
      const amount = moneyOf(price?.price)
      if (amount === undefined || amount <= 0) continue
      const title = typeof price?.title === "string" ? price.title : ""
      const divisor = spec.divisorFromTitle && /thousand/i.test(title) ? 1000 : 1
      out.push({
        metric,
        unit: spec.unit,
        priceUsd: round9(amount / divisor),
        title,
        priceRaw: price.price,
        criteria: Array.isArray(tier.criteria) ? tier.criteria : [],
      })
    }
  }
  return out
}

/**
 * Parse one Replicate model page.
 *
 * @param {string} html
 * @returns {import("./replicate-model-page.d.mts").ParsedReplicateModelPage}
 */
export function parseReplicateModelPage(html) {
  const payload = findModelPayload(html)
  const hardwarePrice = parseTopLevelPrice(payload.price)
  const tierPrices = tierPricesOf(payload.billingConfig)
  if (!hardwarePrice && tierPrices.length === 0) {
    throw new Error(
      "Replicate model page: billing payload has neither a top-level price nor a mappable per-unit tier - page shape changed"
    )
  }
  const p50 = moneyOf(payload.p50price)
  return {
    owner: payload.model.owner,
    name: payload.model.name,
    ...(typeof payload.hardware === "string" ? { hardware: payload.hardware } : {}),
    billingConfig: payload.billingConfig ?? null,
    hardwarePrice,
    p50PriceUsd: p50,
    tierPrices,
  }
}

/**
 * Pick the canonical entry to publish for a parsed page:
 *   - a mappable per-unit tier (per image, per second, ...) wins, because that
 *     is the model's real billing rate;
 *   - otherwise fall back to the top-level per-second hardware rate.
 * Returns null when neither is expressible in {@link MediaPriceUnit}.
 *
 * @param {import("./replicate-model-page.d.mts").ParsedReplicateModelPage} page
 * @returns {import("./replicate-model-page.d.mts").ReplicateSelectedPrice | null}
 */
export function selectReplicatePrice(page) {
  const tier = page.tierPrices[0]
  if (tier) {
    return {
      unit: tier.unit,
      priceUsd: tier.priceUsd,
      metric: tier.metric,
      title: tier.title,
    }
  }
  if (page.hardwarePrice && page.hardwarePrice.unit) {
    return {
      unit: page.hardwarePrice.unit,
      priceUsd: page.hardwarePrice.amount,
      metric: "hardware",
      title: page.hardwarePrice.raw,
    }
  }
  return null
}

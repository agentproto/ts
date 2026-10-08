#!/usr/bin/env node
/**
 * Moonshot/Kimi pricing sync — fetches live model list from
 * `GET https://api.moonshot.ai/v1/models` (or falls back to OpenRouter),
 * and OpenRouter pricing, regenerates
 * `packages/model-catalog/src/llm/moonshot-pricing.generated.ts`.
 *
 * MOONSHOT_API_KEY is optional: without it, or when the API fails, ids come
 * from the committed snapshot packages/catalog-sync/snapshots/llm-moonshot.json
 * (Moonshot's own /v1/models), then from OpenRouter as a last resort.
 *
 * PRICES come first from Moonshot's own pricing page
 * (platform.kimi.ai/docs/pricing/chat.md, no key needed), parsed by
 * packages/catalog-sync/src/sources/kimi-pricing-page.mjs. OpenRouter's
 * `moonshotai/*` price is the price of whichever host OpenRouter routes to,
 * not Moonshot's — 2026-10-08 it had kimi-k3 at $0.62 / $12.30 against
 * Moonshot's $3.00 / $15.00 — so it is only the per-row fallback for an id
 * the page doesn't list, and the whole-file fallback when the page is
 * unreachable or unparseable. Ids the page prices are added to the id list
 * (the page is first-party). Each row records its `priceSource`.
 */

import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

import {
  checkKimiPricingUsable,
  parseKimiPricingPage,
} from "../../packages/catalog-sync/src/sources/kimi-pricing-page.mjs"

// Moonshot's own /v1/models, pinned by `catalog-sync generate --refresh`.
const SNAPSHOT_PATH = resolve(
  import.meta.dirname,
  "../../packages/catalog-sync/snapshots/llm-moonshot.json"
)

function readSnapshotIds() {
  try {
    return (JSON.parse(readFileSync(SNAPSHOT_PATH, "utf-8")).data || [])
      .filter((m) => m.id && !m.archived)
      .map((m) => ({ id: m.id }))
  } catch {
    return []
  }
}

const KIMI_PRICING_URL = "https://platform.kimi.ai/docs/pricing/chat.md"

/** Moonshot's own prices — `{ prices, reason }`, `prices` null if unusable. */
async function fetchKimiPricing() {
  try {
    const res = await fetch(KIMI_PRICING_URL, {
      headers: { Accept: "text/markdown, text/plain;q=0.9, */*;q=0.1" },
    })
    if (!res.ok) return { prices: null, reason: `pricing page returned ${res.status} ${res.statusText}` }
    const prices = parseKimiPricingPage(await res.text())
    const problem = checkKimiPricingUsable(prices)
    return problem ? { prices: null, reason: problem } : { prices, reason: null }
  } catch (err) {
    return { prices: null, reason: `pricing page fetch failed: ${err.message}` }
  }
}

const OUTPUT_PATH = resolve(
  import.meta.dirname,
  "../../packages/model-catalog/src/llm/moonshot-pricing.generated.ts"
)

/** Round to 4 decimal places to avoid floating point artifacts */
function round4(num) {
  return Math.round(num * 10000) / 10000
}

async function fetchMoonshotModels(apiKey) {
  const res = await fetch("https://api.moonshot.ai/v1/models", {
    headers: { Authorization: `Bearer ${apiKey}` },
  })
  if (!res.ok) {
    throw new Error(
      `Moonshot Models API returned ${res.status} ${res.statusText}`
    )
  }
  const json = await res.json()
  return json.data || []
}

async function fetchOpenRouterModels() {
  const res = await fetch("https://openrouter.ai/api/v1/models")
  if (!res.ok) {
    throw new Error(
      `OpenRouter Models API returned ${res.status} ${res.statusText}`
    )
  }
  const json = await res.json()
  return json.data || []
}

/**
 * Try to find OpenRouter pricing for a Moonshot/Kimi model id.
 * Tries in order:
 * 1. "moonshotai/" + id
 * 2. "moonshotai/" + id with dots replaced by dashes
 * 3. "moonshotai/" + id with dashes-between-digits replaced by dots
 */
function findPricing(id, openRouterMap) {
  // Try exact match: moonshotai/<id>
  const exactKey = `moonshotai/${id}`
  if (openRouterMap[exactKey]) {
    return openRouterMap[exactKey]
  }

  // Try with dots replaced by dashes in the id
  const dashesKey = `moonshotai/${id.replace(/\./g, "-")}`
  if (openRouterMap[dashesKey]) {
    return openRouterMap[dashesKey]
  }

  // Try with dashes-between-digits replaced by dots
  const dotsKey = `moonshotai/${id.replace(/(\d)-(\d)/g, "$1.$2")}`
  if (openRouterMap[dotsKey]) {
    return openRouterMap[dotsKey]
  }

  return null
}

async function main() {
  const apiKey = process.env.MOONSHOT_API_KEY
  let idSource = "OpenRouter fallback"
  let moonshotModels = []

  if (apiKey) {
    try {
      console.log("→ Fetching Moonshot model list…")
      moonshotModels = await fetchMoonshotModels(apiKey)
      console.log(`  ${moonshotModels.length} models received from Moonshot API`)
      idSource = "Moonshot API"
      // Filter archived models if the API exposes that field
      moonshotModels = moonshotModels.filter((m) => !m.archived)
      // Extract just the id
      moonshotModels = moonshotModels.map((m) => ({ id: m.id }))
    } catch (err) {
      console.log(`  Moonshot API failed: ${err.message} — falling back to the committed snapshot`)
    }
  }

  if (!moonshotModels.length) {
    moonshotModels = readSnapshotIds()
    if (moonshotModels.length) idSource = "llm-moonshot.json snapshot"
  }

  if (!moonshotModels.length) {
    // Fall back to OpenRouter for id list
    console.log("→ Using OpenRouter as id source…")
    const openRouterModels = await fetchOpenRouterModels()
    moonshotModels = openRouterModels
      .filter((m) => m.id?.startsWith("moonshotai/"))
      .map((m) => {
        const id = m.id.replace(/^moonshotai\//, "")
        return { id }
      })
    idSource = "OpenRouter fallback"
  }

  console.log(`  ${moonshotModels.length} model ids from ${idSource}`)

  console.log("→ Fetching OpenRouter model list for pricing…")
  const openRouterModels = await fetchOpenRouterModels()
  console.log(`  ${openRouterModels.length} models received`)

  // Build OpenRouter pricing map for moonshotai models
  const openRouterMap = {}
  for (const model of openRouterModels) {
    if (!model.id?.startsWith("moonshotai/")) continue
    if (!model.pricing?.prompt || !model.pricing?.completion) continue

    const id = model.id
    const promptPerToken = parseFloat(model.pricing.prompt)
    // OpenRouter prices are in USD per token, so multiply by 1e6 to get per 1M
    const inputPer1M = round4(promptPerToken * 1e6)
    const outputPer1M = round4(parseFloat(model.pricing.completion) * 1e6)
    const entry = { inputPer1M, outputPer1M }
    // Derive cacheReadMultiplier from input_cache_read / prompt ratio (same
    // pattern as sync-anthropic.mjs / sync-google.mjs). OpenRouter's
    // moonshotai/* routes carry no input_cache_write field — cacheWriteMultiplier
    // is never derivable from this source.
    if (model.pricing.input_cache_read && promptPerToken > 0) {
      const ratio = parseFloat(model.pricing.input_cache_read) / promptPerToken
      if (Number.isFinite(ratio)) entry.cacheReadMultiplier = round4(ratio)
    }
    openRouterMap[id] = entry
  }
  console.log(`  ${Object.keys(openRouterMap).length} Moonshot models with pricing found`)

  console.log("→ Fetching Moonshot's own pricing page…")
  const { prices: officialPrices, reason: officialProblem } = await fetchKimiPricing()
  if (officialPrices) {
    console.log(`  ${officialPrices.size} priced rows parsed`)
    const known = new Set(moonshotModels.map((m) => m.id))
    for (const id of officialPrices.keys()) {
      if (!known.has(id)) moonshotModels.push({ id })
    }
  } else {
    console.warn(`  ⚠ official pricing unusable (${officialProblem}) — every price from OpenRouter`)
  }

  const entries = []
  for (const model of moonshotModels) {
    if (!model.id) continue
    const official = officialPrices?.get(model.id)
    if (official) {
      entries.push({ id: model.id, ...official, priceSource: "moonshot" })
      continue
    }
    const pricing = findPricing(model.id, openRouterMap)
    if (pricing) {
      entries.push({
        id: model.id,
        inputPer1M: pricing.inputPer1M,
        outputPer1M: pricing.outputPer1M,
        cacheReadMultiplier: pricing.cacheReadMultiplier,
        priceSource: "openrouter",
      })
    } else {
      console.log(`  No pricing found for: ${model.id}`)
    }
  }

  // Sort alphabetically by id
  entries.sort((a, b) => a.id.localeCompare(b.id))

  const date = new Date().toISOString()
  const priceSourceLabel = officialPrices
    ? "platform.kimi.ai pricing page, OpenRouter fallback per row"
    : `OpenRouter pricing — Moonshot pricing page unusable: ${officialProblem}`
  const banner = `// GENERATED FILE — do not edit; regenerate with scripts/catalog-sync/sync-moonshot.mjs (data: ${idSource} + ${priceSourceLabel}, synced ${date})\n\n`

  const body = entries
    .map((e) => {
      const cacheParts = []
      if (e.cacheReadMultiplier !== undefined) cacheParts.push(`cacheReadMultiplier: ${e.cacheReadMultiplier}`)
      if (e.cacheWriteMultiplier !== undefined) cacheParts.push(`cacheWriteMultiplier: ${e.cacheWriteMultiplier}`)
      const cache = cacheParts.length > 0 ? `, ${cacheParts.join(", ")}` : ""
      return `  ${JSON.stringify(e.id)}: { inputPer1M: ${e.inputPer1M}, outputPer1M: ${e.outputPer1M}${cache}, priceSource: ${JSON.stringify(e.priceSource)}, vendor: "moonshot", provider: "moonshot" },`
    })
    .join("\n")

  const file = `${banner}export const MOONSHOT_GENERATED_PRICING = {\n${body}\n} as const\n`

  writeFileSync(OUTPUT_PATH, file, "utf-8")
  console.log(`✓ Wrote ${OUTPUT_PATH}`)
  console.log(`  ${entries.length} models with pricing written`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

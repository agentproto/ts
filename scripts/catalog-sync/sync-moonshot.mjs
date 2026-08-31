#!/usr/bin/env node
/**
 * Moonshot/Kimi pricing sync — fetches live model list from
 * `GET https://api.moonshot.ai/v1/models` (or falls back to OpenRouter),
 * and OpenRouter pricing, regenerates
 * `packages/model-catalog/src/llm/moonshot-pricing.generated.ts`.
 *
 * Needs MOONSHOT_API_KEY (optional — falls back to OpenRouter if unset or API fails).
 */

import { writeFileSync } from "node:fs"
import { resolve } from "node:path"

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
      console.log(`  Moonshot API failed: ${err.message} — falling back to OpenRouter`)
      idSource = "OpenRouter fallback"
    }
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

  // Match Moonshot model ids with OpenRouter pricing
  const entries = []
  for (const model of moonshotModels) {
    if (!model.id) continue
    const pricing = findPricing(model.id, openRouterMap)
    if (pricing) {
      entries.push({
        id: model.id,
        inputPer1M: pricing.inputPer1M,
        outputPer1M: pricing.outputPer1M,
        cacheReadMultiplier: pricing.cacheReadMultiplier,
      })
    } else {
      console.log(`  No pricing found for: ${model.id}`)
    }
  }

  // Sort alphabetically by id
  entries.sort((a, b) => a.id.localeCompare(b.id))

  const date = new Date().toISOString()
  const banner = `// GENERATED FILE — do not edit; regenerate with scripts/catalog-sync/sync-moonshot.mjs (data: ${idSource} + OpenRouter pricing, synced ${date})\n\n`

  const body = entries
    .map((e) => {
      const cache = e.cacheReadMultiplier !== undefined ? `, cacheReadMultiplier: ${e.cacheReadMultiplier}` : ""
      return `  ${JSON.stringify(e.id)}: { inputPer1M: ${e.inputPer1M}, outputPer1M: ${e.outputPer1M}${cache}, vendor: "moonshot", provider: "moonshot" },`
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

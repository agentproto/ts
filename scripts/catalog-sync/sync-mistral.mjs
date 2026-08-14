#!/usr/bin/env node
/**
 * Mistral pricing sync — fetches live model list from
 * `GET https://api.mistral.ai/v1/models` and OpenRouter pricing,
 * regenerates `packages/model-catalog/src/llm/mistral-pricing.generated.ts`.
 *
 * Needs MISTRAL_API_KEY. Exits 2 (skip, not a hard failure) when the key
 * isn't set.
 */

import { writeFileSync } from "node:fs"
import { resolve } from "node:path"

const OUTPUT_PATH = resolve(
  import.meta.dirname,
  "../../packages/model-catalog/src/llm/mistral-pricing.generated.ts"
)

// Regex to exclude non-chat models
const EXCLUDE_REGEX = /-(embed|moderation|ocr|transcribe|tts|realtime)-/i

/** Round to 4 decimal places to avoid floating point artifacts */
function round4(num) {
  return Math.round(num * 10000) / 10000
}

async function fetchMistralModels(apiKey) {
  const res = await fetch("https://api.mistral.ai/v1/models", {
    headers: { Authorization: `Bearer ${apiKey}` },
  })
  if (!res.ok) {
    throw new Error(
      `Mistral Models API returned ${res.status} ${res.statusText}`
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
 * Try to find OpenRouter pricing for a Mistral model id.
 * Tries in order:
 * 1. "mistralai/" + id
 * 2. "mistralai/" + id with dots replaced by dashes
 * 3. "mistralai/" + id with dashes-between-digits replaced by dots
 */
function findPricing(id, openRouterMap) {
  // Try exact match: mistralai/<id>
  const exactKey = `mistralai/${id}`
  if (openRouterMap[exactKey]) {
    return openRouterMap[exactKey]
  }

  // Try with dots replaced by dashes in the id
  const dashesKey = `mistralai/${id.replace(/\./g, "-")}`
  if (openRouterMap[dashesKey]) {
    return openRouterMap[dashesKey]
  }

  // Try with dashes-between-digits replaced by dots
  // e.g. mistral-medium-3-5 -> mistralai/mistral-medium-3.5
  const dotsKey = `mistralai/${id.replace(/(\d)-(\d)/g, "$1.$2")}`
  if (openRouterMap[dotsKey]) {
    return openRouterMap[dotsKey]
  }

  return null
}

async function main() {
  const apiKey = process.env.MISTRAL_API_KEY
  if (!apiKey) {
    console.log(
      "  MISTRAL_API_KEY not set — skipping Mistral pricing sync."
    )
    process.exit(2)
  }

  console.log("→ Fetching Mistral model list…")
  const mistralModels = await fetchMistralModels(apiKey)
  console.log(`  ${mistralModels.length} models received`)

  // Filter: completion_chat capability, not archived, exclude non-chat models
  const chatModels = mistralModels.filter((m) => {
    if (!m.id || m.archived === true) return false
    if (EXCLUDE_REGEX.test(m.id)) return false
    return m.capabilities?.completion_chat === true
  })
  console.log(`  ${chatModels.length} active chat models kept`)

  console.log("→ Fetching OpenRouter model list…")
  const openRouterModels = await fetchOpenRouterModels()
  console.log(`  ${openRouterModels.length} models received`)

  // Build OpenRouter pricing map for mistralai models
  const openRouterMap = {}
  for (const model of openRouterModels) {
    if (!model.id?.startsWith("mistralai/")) continue
    if (!model.pricing?.prompt || !model.pricing?.completion) continue
    
    const id = model.id
    // OpenRouter prices are in USD per token, so multiply by 1e6 to get per 1M
    const inputPer1M = round4(parseFloat(model.pricing.prompt) * 1e6)
    const outputPer1M = round4(parseFloat(model.pricing.completion) * 1e6)
    
    openRouterMap[id] = { inputPer1M, outputPer1M }
  }
  console.log(`  ${Object.keys(openRouterMap).length} Mistral models with pricing found`)

  // Match Mistral models with OpenRouter pricing
  const entries = []
  for (const model of chatModels) {
    const pricing = findPricing(model.id, openRouterMap)
    if (pricing) {
      entries.push({
        id: model.id,
        inputPer1M: pricing.inputPer1M,
        outputPer1M: pricing.outputPer1M,
      })
    } else {
      console.log(`  No pricing found for: ${model.id}`)
    }
  }

  // Sort alphabetically by id
  entries.sort((a, b) => a.id.localeCompare(b.id))

  const date = new Date().toISOString()
  const banner = `// GENERATED FILE — do not edit; regenerate with scripts/catalog-sync/sync-mistral.mjs (data: Mistral /v1/models + OpenRouter pricing, synced ${date})\n\n`

  const body = entries
    .map((e) => {
      return `  ${JSON.stringify(e.id)}: { inputPer1M: ${e.inputPer1M}, outputPer1M: ${e.outputPer1M}, vendor: "mistral", provider: "mistral" },`
    })
    .join("\n")

  const file = `${banner}export const MISTRAL_GENERATED_PRICING = {\n${body}\n} as const\n`

  writeFileSync(OUTPUT_PATH, file, "utf-8")
  console.log(`✓ Wrote ${OUTPUT_PATH}`)
  console.log(`  ${entries.length} models with pricing written`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

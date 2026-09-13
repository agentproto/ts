#!/usr/bin/env node
/**
 * OpenAI pricing sync — OpenAI publishes NO stable machine-readable models or
 * pricing endpoint (see packages/catalog-sync/src/sources/openai.ts, which is
 * `refreshable: false` for exactly this reason). There is no OpenAI key to
 * look for: this script does not even try.
 *
 * Instead it takes BOTH the id list and the prices from OpenRouter's public
 * `GET https://openrouter.ai/api/v1/models` passthrough, the same fallback
 * mechanism `sync-moonshot.mjs` uses when MOONSHOT_API_KEY is unset —
 * filtered to `openai/*` ids, ids taken as the suffix after the slash, prices
 * from `pricing.prompt` / `pricing.completion` (USD per token, × 1e6 → per 1M).
 *
 * ⚠ The result reflects OpenRouter's rates, NOT the official
 * openai.com/api/pricing page — the generated banner says so explicitly.
 *
 * cacheReadMultiplier and cacheWriteMultiplier are derived per model from
 * OpenRouter's input_cache_read / input_cache_write fields (ratio to base
 * prompt price), same pattern as sync-anthropic.mjs / sync-google.mjs — 41
 * of the 60 openai/* OpenRouter routes carry a cache-read price.
 *
 * Regenerates `packages/model-catalog/src/llm/openai-pricing.generated.ts`.
 */

import { writeFileSync } from "node:fs"
import { resolve } from "node:path"

const OUTPUT_PATH = resolve(
  import.meta.dirname,
  "../../packages/model-catalog/src/llm/openai-pricing.generated.ts"
)

// Non-chat OpenAI families (speech, image gen, embeddings, moderation,
// realtime voice, ...) — adapted from sync-mistral.mjs's EXCLUDE_REGEX, but
// token-anchored instead of dash-bounded because OpenAI ids are not
// dash-segmented (`whisper-1`, `tts-1-hd`, `text-embedding-3-small` have no
// trailing dash after the family token).
//
// `-image-\d` specifically excludes versioned image-output multimodal
// variants (e.g. `gpt-5.4-image-2`) that OpenRouter carries with standard
// prompt/completion pricing but this catalog has never treated as
// first-party-routable products — only the two already-curated exceptions
// (`gpt-5-image`, `gpt-5-image-mini`, no digit after "image") stay
// includable; see packages/runtime/src/__tests__/spawn-model-eligibility.test.ts
// for the route-eligibility assumption this protects.
const EXCLUDE_REGEX = /embed|moderation|whisper|tts|dall-e|realtime|transcribe|ocr|gpt-image|-image-\d/i

/** Round to 6 decimal places (matches sync-anthropic.mjs / sync-google.mjs
 *  precision — cache-multiplier ratios need more than 4 decimals). */
function round6(num) {
  return Math.round(num * 1_000_000) / 1_000_000
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

async function main() {
  // No OpenAI key to look for: OpenAI has no listable models endpoint with
  // pricing (packages/catalog-sync/src/sources/openai.ts), so OpenRouter is
  // the sole id AND pricing source, unconditionally.
  console.log("→ Fetching OpenRouter model list (ids + pricing passthrough)…")
  const openRouterModels = await fetchOpenRouterModels()
  console.log(`  ${openRouterModels.length} models received`)

  const entries = []
  for (const model of openRouterModels) {
    if (!model.id?.startsWith("openai/")) continue
    if (EXCLUDE_REGEX.test(model.id)) continue
    if (!model.pricing?.prompt || !model.pricing?.completion) continue

    const id = model.id.replace(/^openai\//, "")
    const promptPerToken = parseFloat(model.pricing.prompt)
    const completionPerToken = parseFloat(model.pricing.completion)
    // OpenRouter prices are in USD per token, so multiply by 1e6 to get per 1M
    const inputPer1M = round6(promptPerToken * 1e6)
    const outputPer1M = round6(completionPerToken * 1e6)

    const entry = { id, inputPer1M, outputPer1M }

    if (model.pricing.input_cache_read && promptPerToken > 0) {
      const ratio = parseFloat(model.pricing.input_cache_read) / promptPerToken
      if (Number.isFinite(ratio)) entry.cacheReadMultiplier = round6(ratio)
    }
    if (model.pricing.input_cache_write && promptPerToken > 0) {
      const ratio = parseFloat(model.pricing.input_cache_write) / promptPerToken
      if (Number.isFinite(ratio)) entry.cacheWriteMultiplier = round6(ratio)
    }

    entries.push(entry)
  }
  console.log(`  ${entries.length} openai/* chat models with pricing kept`)
  console.log(`  ${entries.filter((e) => e.cacheReadMultiplier !== undefined).length} with a cache-read multiplier`)

  // Sort alphabetically by id
  entries.sort((a, b) => a.id.localeCompare(b.id))

  const date = new Date().toISOString()
  const banner =
    `// GENERATED FILE — do not edit; regenerate with scripts/catalog-sync/sync-openai.mjs ` +
    `(data: OpenRouter passthrough — OpenAI has NO native models/pricing endpoint, ` +
    `see packages/catalog-sync/src/sources/openai.ts, synced ${date})\n` +
    `//\n` +
    `// ⚠ These prices are OpenRouter's rates, NOT the official\n` +
    `// openai.com/api/pricing page. OpenAI publishes no stable machine-readable\n` +
    `// models/pricing endpoint, so OpenRouter passthrough is the only automated\n` +
    `// source for both ids and prices; OpenRouter rates may differ from\n` +
    `// OpenAI's first-party pricing.\n\n`

  const body = entries
    .map((e) => {
      const pricing = `inputPer1M: ${e.inputPer1M}, outputPer1M: ${e.outputPer1M}`
      const cacheParts = []
      if (e.cacheReadMultiplier !== undefined) cacheParts.push(`cacheReadMultiplier: ${e.cacheReadMultiplier}`)
      if (e.cacheWriteMultiplier !== undefined) cacheParts.push(`cacheWriteMultiplier: ${e.cacheWriteMultiplier}`)
      const cache = cacheParts.length > 0 ? `, ${cacheParts.join(", ")}` : ""
      return `  ${JSON.stringify(e.id)}: { ${pricing}${cache}, vendor: "openai", provider: "openai" },`
    })
    .join("\n")

  const file = `${banner}export const OPENAI_GENERATED_PRICING = {\n${body}\n} as const\n`

  writeFileSync(OUTPUT_PATH, file, "utf-8")
  console.log(`✓ Wrote ${OUTPUT_PATH}`)
  console.log(`  ${entries.length} models with pricing written`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

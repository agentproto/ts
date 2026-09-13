#!/usr/bin/env node
/**
 * Google/Gemini pricing sync — fetches OpenRouter `/api/v1/models`, filters
 * `google/<id>` routes, remaps to bare native Gemini ids, and regenerates
 * `packages/model-catalog/src/llm/google-pricing.generated.ts`.
 *
 * No Google API key needed: Google's native API is billing-blocked (403
 * PERMISSION_DENIED — dunning, verified 2026-08-30); pricing is sourced from
 * OpenRouter's published rates for the `google/` routes, which are the same
 * per-token costs the native API charges (OpenRouter passes through Google's
 * list price with no markup on the base model). See the module doc comment in
 * `packages/catalog-sync/src/generators/llm-context-windows.ts` for the full
 * context of why Google's native API is unavailable.
 *
 * Only models whose native id is in `GOOGLE_NATIVE_MODEL_IDS` (imported from
 * `packages/catalog-sync/src/generators/google-native-model-ids.mjs`) are
 * emitted — everything else under `google/` on OpenRouter is logged and
 * skipped (see skip rules in the source).
 */

import { writeFileSync } from "node:fs"
import { resolve } from "node:path"

import { GOOGLE_NATIVE_MODEL_IDS } from "../../packages/catalog-sync/src/generators/google-native-model-ids.mjs"

const OUTPUT_PATH = resolve(
  import.meta.dirname,
  "../../packages/model-catalog/src/llm/google-pricing.generated.ts"
)

function round6(n) {
  return Math.round(n * 1_000_000) / 1_000_000
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
  console.log("→ Fetching OpenRouter model list…")
  const openRouterModels = await fetchOpenRouterModels()
  console.log(`  ${openRouterModels.length} models received`)

  // Build entries from google/ routes, remapped to bare native ids
  const entries = []

  for (const model of openRouterModels) {
    if (!model.id?.startsWith("google/")) continue
    if (!model.pricing?.prompt || !model.pricing?.completion) {
      console.log(`  Skipping "${model.id}" — missing pricing`)
      continue
    }

    const nativeId = model.id.slice("google/".length)

    // Skip :batch suffixed routes (distinct billing surface)
    if (model.id.includes(":")) {
      console.log(
        `  Skipping "${model.id}" — ":batch" route, not the base model`
      )
      continue
    }

    // Only emit ids in the allow-list
    if (!GOOGLE_NATIVE_MODEL_IDS.has(nativeId)) {
      console.log(
        `  Skipping "${model.id}" — native id "${nativeId}" not in GOOGLE_NATIVE_MODEL_IDS`
      )
      continue
    }

    const inputPer1M = round6(parseFloat(model.pricing.prompt) * 1_000_000)
    const outputPer1M = round6(parseFloat(model.pricing.completion) * 1_000_000)

    const entry = {
      id: nativeId,
      inputPer1M,
      outputPer1M,
    }

    // Compute cacheReadMultiplier from OpenRouter's input_cache_read if present
    if (model.pricing.input_cache_read && model.pricing.prompt) {
      const cacheReadPerToken = parseFloat(model.pricing.input_cache_read)
      const promptPerToken = parseFloat(model.pricing.prompt)
      if (
        Number.isFinite(cacheReadPerToken) &&
        Number.isFinite(promptPerToken) &&
        promptPerToken > 0
      ) {
        entry.cacheReadMultiplier = round6(cacheReadPerToken / promptPerToken)
      }
    }

    entries.push(entry)
    console.log(`  ✓ ${nativeId}: $${inputPer1M}/1M in, $${outputPer1M}/1M out`)
  }

  // Sort alphabetically by id
  entries.sort((a, b) => a.id.localeCompare(b.id))

  const date = new Date().toISOString()
  const banner =
    `// GENERATED FILE — do not edit; regenerate with scripts/catalog-sync/sync-google.mjs ` +
    `(data: OpenRouter remap — Google native API blocked, see llm-context-windows.ts, synced ${date})\n\n`

  const body = entries
    .map((e) => {
      const pricing = `inputPer1M: ${e.inputPer1M}, outputPer1M: ${e.outputPer1M}`
      const cache =
        e.cacheReadMultiplier !== undefined
          ? `, cacheReadMultiplier: ${e.cacheReadMultiplier}`
          : ""
      return `  ${JSON.stringify(e.id)}: { ${pricing}${cache}, vendor: "google", provider: "google" },`
    })
    .join("\n")

  const file =
    `${banner}export const GOOGLE_GENERATED_PRICING = {\n${body}\n} as const\n`

  writeFileSync(OUTPUT_PATH, file, "utf-8")
  console.log(`✓ Wrote ${OUTPUT_PATH}`)
  console.log(`  ${entries.length} models with pricing written`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
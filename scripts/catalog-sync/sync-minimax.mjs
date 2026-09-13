#!/usr/bin/env node
/**
 * MiniMax pricing sync — native ids from the committed PascalCase catalog
 * (the only known native id list while MINIMAX_API_KEY is unavailable),
 * prices from OpenRouter.
 *
 * Regenerates `packages/model-catalog/src/llm/minimax-pricing.generated.ts`.
 *
 * NORMALIZATION (PascalCase native id → OpenRouter suffix):
 *   lowercase the id, then if the result doesn't already start with
 *   "minimax-", prepend "minimax-".  This handles all 5 known ids:
 *     MiniMax-M2  → minimax-m2
 *     M2-her      → minimax-m2-her   (short form, prepend needed)
 *     MiniMax-M2.1 → minimax-m2.1
 *     MiniMax-M2.5 → minimax-m2.5
 *     MiniMax-M2.7 → minimax-m2.7
 *
 * cacheReadMultiplier is derived from OpenRouter's input_cache_read field
 * where present (same pattern as sync-anthropic.mjs / sync-openai.mjs).
 * NOTE: OpenRouter's minimax/* routes never carry an input_cache_write
 * field at all (verified live) — cacheWriteMultiplier cannot be derived
 * from this source for ANY MiniMax model, regardless of id. Flagged in
 * the generated banner; see the PR body for the consequence.
 */
import { writeFileSync } from "node:fs"
import { resolve } from "node:path"

const OUTPUT_PATH = resolve(
  import.meta.dirname,
  "../../packages/model-catalog/src/llm/minimax-pricing.generated.ts"
)

/** Round to 6 decimal places (matches sync-anthropic.mjs precision — cache
 *  ratios need more than 4 decimals). */
function round6(num) {
  return Math.round(num * 1_000_000) / 1_000_000
}

/**
 * Normalise a PascalCase native MiniMax id to an OpenRouter suffix.
 *
 *   MiniMax-M2  → minimax-m2
 *   M2-her      → minimax-m2-her   (prepend because lowercase is just "m2-her")
 */
function nativeIdToOrSuffix(id) {
  const lower = id.toLowerCase()
  if (lower.startsWith("minimax-")) return lower
  return `minimax-${lower}`
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
  // ── Native id list ──────────────────────────────────────────────────
  // Source: packages/model-catalog/src/llm/catalog.ts lines 587–624
  // (committed hand-maintained catalog, no MINIMUM_API_KEY available).
  const NATIVE_IDS = [
    "MiniMax-M2",
    "M2-her",
    "MiniMax-M2.1",
    "MiniMax-M2.5",
    "MiniMax-M2.7",
  ]

  console.log("→ Fetching OpenRouter model list for pricing…")
  const openRouterModels = await fetchOpenRouterModels()
  console.log(`  ${openRouterModels.length} models received`)

  // Build OpenRouter pricing map for minimax/* models: suffix → pricing
  const orPricingMap = {}
  for (const model of openRouterModels) {
    if (!model.id?.startsWith("minimax/")) continue
    if (!model.pricing?.prompt || !model.pricing?.completion) continue
    const suffix = model.id.replace(/^minimax\//, "")
    const promptPerToken = parseFloat(model.pricing.prompt)
    const inputPer1M = round6(promptPerToken * 1e6)
    const outputPer1M = round6(parseFloat(model.pricing.completion) * 1e6)
    const entry = { inputPer1M, outputPer1M }
    if (model.pricing.input_cache_read && promptPerToken > 0) {
      const ratio = parseFloat(model.pricing.input_cache_read) / promptPerToken
      if (Number.isFinite(ratio)) entry.cacheReadMultiplier = round6(ratio)
    }
    // No input_cache_write field exists anywhere in minimax/* OpenRouter
    // routes (verified live) — cacheWriteMultiplier is never derivable here.
    orPricingMap[suffix] = entry
  }
  console.log(`  ${Object.keys(orPricingMap).length} minimax/* models with pricing in OpenRouter`)

  // ── Match known native ids with OpenRouter pricing ─────────────────
  const priced = []
  const missing = []
  for (const nativeId of NATIVE_IDS) {
    const orSuffix = nativeIdToOrSuffix(nativeId)
    const pricing = orPricingMap[orSuffix]
    if (pricing) {
      priced.push({ id: nativeId, ...pricing })
      console.log(`  ✓ ${nativeId}: matched OpenRouter ${orSuffix}`)
    } else {
      missing.push(nativeId)
      console.log(`  ✗ ${nativeId}: NOT found in OpenRouter (looked for "${orSuffix}")`)
    }
  }

  // ── Finds: OpenRouter models with no matching native id ────────────
  const knownSuffixes = new Set(NATIVE_IDS.map((id) => nativeIdToOrSuffix(id)))
  const finds = []
  for (const suffix of Object.keys(orPricingMap).sort()) {
    if (!knownSuffixes.has(suffix)) {
      finds.push({
        suffix,
        inputPer1M: orPricingMap[suffix].inputPer1M,
        outputPer1M: orPricingMap[suffix].outputPer1M,
      })
    }
  }

  // Sort by native id
  priced.sort((a, b) => a.id.localeCompare(b.id))

  // ── Emit generated file ─────────────────────────────────────────────
  const date = new Date().toISOString()

  const banner = `// GENERATED FILE — do not edit; regenerate with scripts/catalog-sync/sync-minimax.mjs
// (ids: committed PascalCase native list from catalog.ts, pricing: OpenRouter /v1/models (minimax/*), synced ${date})
// Normalization: lowercase → prepend "minimax-" when missing
// Known native ids: MiniMax-M2, M2-her, MiniMax-M2.1, MiniMax-M2.5, MiniMax-M2.7
//
// ⚠ cacheReadMultiplier is derived from OpenRouter's input_cache_read where
// present; OpenRouter's minimax/* routes carry NO input_cache_write field at
// all, for any id — cacheWriteMultiplier can never be derived from this
// source. See the PR body for the consequence on ids that had a manual
// cacheWriteMultiplier.

`

  const body = priced
    .map((e) => {
      const pricing = `inputPer1M: ${e.inputPer1M}, outputPer1M: ${e.outputPer1M}`
      const cache = e.cacheReadMultiplier !== undefined ? `, cacheReadMultiplier: ${e.cacheReadMultiplier}` : ""
      return `  ${JSON.stringify(e.id)}: { ${pricing}${cache}, vendor: "minimax", provider: "minimax" },`
    })
    .join("\n")

  const file = `${banner}export const MINIMAX_GENERATED_PRICING = {\n${body}\n} as const\n`

  writeFileSync(OUTPUT_PATH, file, "utf-8")
  console.log(`\n✓ Wrote ${OUTPUT_PATH}`)
  console.log(`  ${priced.length} native ids with pricing written`)
  console.log(`  ${missing.length} native ids with no OpenRouter price`)

  if (finds.length > 0) {
    console.log("\n═══ FINDS — OpenRouter models NOT matching any known native id ═══")
    console.log("  (raw OpenRouter suffix + pricing — no PascalCase invented)")
    for (const f of finds) {
      console.log(`  minimax/${f.suffix}: input=${f.inputPer1M}, output=${f.outputPer1M}`)
    }
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
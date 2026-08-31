#!/usr/bin/env node
/**
 * Anthropic pricing sync — fetches live model list from
 * `GET https://api.anthropic.com/v1/models?limit=1000` (if ANTHROPIC_API_KEY
 * is set), or falls back to the canonical native Anthropic model ids embedded
 * below (sourced from packages/catalog-sync/snapshots/llm-anthropic.json /
 * packages/model-catalog/src/llm/context-windows.generated.ts — the
 * `provider: "anthropic"` entries), and OpenRouter pricing for each.
 * Regenerates `packages/model-catalog/src/llm/anthropic-pricing.generated.ts`.
 *
 * Emits native Anthropic ids with DASHES (e.g. `claude-opus-4-6`), not
 * OpenRouter dotted variants. Excludes :batch and -fast variants (they are
 * OpenRouter synthetic constructs, not real Anthropic model ids).
 *
 * cacheReadMultiplier and cacheWriteMultiplier are derived per model from
 * OpenRouter's input_cache_read / input_cache_write fields (ratio to base
 * prompt price), following the same pattern as sync-google.mjs.
 */

import { writeFileSync } from "node:fs"
import { resolve } from "node:path"

const OUTPUT_PATH = resolve(
  import.meta.dirname,
  "../../packages/model-catalog/src/llm/anthropic-pricing.generated.ts"
)

// Canonical native Anthropic model ids, sourced from
// packages/catalog-sync/snapshots/llm-anthropic.json (the live
// api.anthropic.com/v1/models snapshot). These are the ONLY valid
// Anthropic model ids — OpenRouter :batch and -fast variants are
// NOT real Anthropic ids and are never emitted.
const NATIVE_ANTHROPIC_IDS = [
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-fable-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-sonnet-4-6",
  "claude-opus-4-6",
  "claude-opus-4-5-20251101",
  "claude-haiku-4-5-20251001",
  "claude-sonnet-4-5-20250929",
]

function round6(n) {
  return Math.round(n * 1_000_000) / 1_000_000
}

async function fetchAnthropicModels(apiKey) {
  const res = await fetch("https://api.anthropic.com/v1/models?limit=1000", {
    headers: { "x-api-key": apiKey },
  })
  if (!res.ok) {
    throw new Error(
      `Anthropic Models API returned ${res.status} ${res.statusText}`
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
 * Resolve an OpenRouter model entry for a native Anthropic model id.
 * The native id uses DASHES (e.g. `claude-opus-4-6`). OpenRouter uses
 * the prefix "anthropic/" with DOTS (e.g. `anthropic/claude-opus-4.6`).
 *
 * Strategies, in order:
 * 1. Exact: "anthropic/" + id
 * 2. Dots→dashes (already dashes, skips)
 * 3. Dashes-between-digits→dots (e.g. `claude-opus-4-6` → `anthropic/claude-opus-4.6`)
 * 4. Strip date suffix -YYYYMMDD, retry 1-3
 */
function resolveOpenRouterEntry(id, openRouterMap) {
  // Strategy 1: exact match
  const exactKey = `anthropic/${id}`
  if (openRouterMap[exactKey]) {
    return openRouterMap[exactKey]
  }

  // Strategy 2: dots replaced by dashes in the id (no-op for dashes-only ids)
  const dashesKey = `anthropic/${id.replace(/\./g, "-")}`
  if (openRouterMap[dashesKey]) {
    return openRouterMap[dashesKey]
  }

  // Strategy 3: dashes-between-digits replaced by dots
  const dotsKey = `anthropic/${id.replace(/(\d)-(\d)/g, "$1.$2")}`
  if (openRouterMap[dotsKey]) {
    return openRouterMap[dotsKey]
  }

  // Strategy 4: strip -YYYYMMDD date suffix, retry strategies 1-3
  const stripped = id.replace(/-\d{8}$/, "")
  if (stripped !== id) {
    const exactStripped = `anthropic/${stripped}`
    if (openRouterMap[exactStripped]) {
      return openRouterMap[exactStripped]
    }
    const dashesStripped = `anthropic/${stripped.replace(/\./g, "-")}`
    if (openRouterMap[dashesStripped]) {
      return openRouterMap[dashesStripped]
    }
    const dotsStripped = `anthropic/${stripped.replace(/(\d)-(\d)/g, "$1.$2")}`
    if (openRouterMap[dotsStripped]) {
      return openRouterMap[dotsStripped]
    }
  }

  return null
}

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY
  let anthropicIds = NATIVE_ANTHROPIC_IDS.map((id) => ({ id }))
  let idSource = ""

  if (apiKey) {
    try {
      console.log("→ Fetching Anthropic model list (live)…")
      const liveModels = await fetchAnthropicModels(apiKey)
      console.log(`  ${liveModels.length} models received from Anthropic API`)
      if (liveModels.length > 0) {
        anthropicIds = liveModels
          .filter((m) => !m.archived)
          .map((m) => ({ id: m.id }))
        idSource = "live api.anthropic.com/v1/models"
      }
    } catch (err) {
      console.log(`  Anthropic API failed: ${err.message} — using CONTEXT_WINDOWS fallback`)
      idSource = "CONTEXT_WINDOWS fallback (ANTHROPIC_API_KEY fetch failed)"
    }
  }

  if (!idSource) {
    idSource = "CONTEXT_WINDOWS fallback (ANTHROPIC_API_KEY unavailable)"
  }

  console.log(`  ${anthropicIds.length} model ids from ${idSource}`)

  console.log("→ Fetching OpenRouter model list for pricing…")
  const openRouterModels = await fetchOpenRouterModels()
  console.log(`  ${openRouterModels.length} models received`)

  // Build OpenRouter lookup map for anthropic models with full pricing data
  const openRouterMap = {}
  for (const model of openRouterModels) {
    if (!model.id?.startsWith("anthropic/")) continue
    if (!model.pricing?.prompt || !model.pricing?.completion) continue

    const id = model.id
    const promptPerToken = parseFloat(model.pricing.prompt)
    const completionPerToken = parseFloat(model.pricing.completion)
    const inputPer1M = round6(promptPerToken * 1_000_000)
    const outputPer1M = round6(completionPerToken * 1_000_000)

    // Store raw per-token prices for cache multiplier derivation
    openRouterMap[id] = {
      inputPer1M,
      outputPer1M,
      promptPerToken,
      inputCacheRead: model.pricing.input_cache_read
        ? parseFloat(model.pricing.input_cache_read)
        : undefined,
      inputCacheWrite: model.pricing.input_cache_write
        ? parseFloat(model.pricing.input_cache_write)
        : undefined,
    }
  }
  console.log(`  ${Object.keys(openRouterMap).length} Anthropic models with pricing found in OpenRouter`)

  // Match native Anthropic model ids with OpenRouter pricing.
  // Output uses native Anthropic ids (DASHES), NOT OpenRouter dotted ids.
  const entries = []
  for (const model of anthropicIds) {
    if (!model.id) continue
    const orEntry = resolveOpenRouterEntry(model.id, openRouterMap)
    if (orEntry) {
      const entry = {
        id: model.id,
        inputPer1M: orEntry.inputPer1M,
        outputPer1M: orEntry.outputPer1M,
      }

      // Derive cacheReadMultiplier from input_cache_read / prompt ratio
      if (
        orEntry.inputCacheRead !== undefined &&
        orEntry.promptPerToken > 0
      ) {
        const ratio = orEntry.inputCacheRead / orEntry.promptPerToken
        if (Number.isFinite(ratio)) {
          entry.cacheReadMultiplier = round6(ratio)
        }
      }

      // Derive cacheWriteMultiplier from input_cache_write / prompt ratio
      if (
        orEntry.inputCacheWrite !== undefined &&
        orEntry.promptPerToken > 0
      ) {
        const ratio = orEntry.inputCacheWrite / orEntry.promptPerToken
        if (Number.isFinite(ratio)) {
          entry.cacheWriteMultiplier = round6(ratio)
        }
      }

      entries.push(entry)
    } else {
      console.log(`  No pricing found for: ${model.id}`)
    }
  }

  // Some Anthropic model generations "age out" of the live /v1/models
  // listing into a dated-only id (e.g. claude-opus-4-5-20251101) while the
  // bare "latest" spelling (claude-opus-4-5) stays a valid, callable
  // back-compat id — just no longer separately listed. Mechanically derive
  // the bare form from every dated entry (strip the trailing -YYYYMMDD),
  // priced IDENTICALLY to its dated sibling, rather than leaving that bare
  // id to either disappear or need a hand-typed number that drifts from the
  // real one. Skips a bare id that's already a distinct, separately-priced
  // entry (a live, non-aged model should never be silently overwritten).
  const byId = new Map(entries.map((e) => [e.id, e]))
  for (const entry of entries) {
    const bare = entry.id.replace(/-\d{8}$/, "")
    if (bare === entry.id) continue
    if (byId.has(bare)) continue
    const bareEntry = { ...entry, id: bare }
    entries.push(bareEntry)
    byId.set(bare, bareEntry)
  }

  // Sort alphabetically by id
  entries.sort((a, b) => a.id.localeCompare(b.id))

  const date = new Date().toISOString()
  const banner = `// GENERATED FILE — do not edit; regenerate with scripts/catalog-sync/sync-anthropic.mjs (data: ${idSource} + OpenRouter pricing, synced ${date})\n\n`

  const body = entries
    .map((e) => {
      const pricing = `inputPer1M: ${e.inputPer1M}, outputPer1M: ${e.outputPer1M}`
      const cacheParts = []
      if (e.cacheReadMultiplier !== undefined) {
        cacheParts.push(`cacheReadMultiplier: ${e.cacheReadMultiplier}`)
      }
      if (e.cacheWriteMultiplier !== undefined) {
        cacheParts.push(`cacheWriteMultiplier: ${e.cacheWriteMultiplier}`)
      }
      const cache = cacheParts.length > 0 ? `, ${cacheParts.join(", ")}` : ""
      return `  ${JSON.stringify(e.id)}: { ${pricing}${cache}, vendor: "anthropic", provider: "anthropic" },`
    })
    .join("\n")

  const file = `${banner}export const ANTHROPIC_GENERATED_PRICING = {\n${body}\n} as const\n`

  writeFileSync(OUTPUT_PATH, file, "utf-8")
  console.log(`\u2713 Wrote ${OUTPUT_PATH}`)
  console.log(`  ${entries.length} models with pricing written`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
#!/usr/bin/env node
/**
 * xAI pricing sync — fetches the live model list with NATIVE pricing from
 * `GET https://api.x.ai/v1/models` (Authorization: Bearer $XAI_API_KEY) and
 * regenerates `packages/model-catalog/src/llm/xai-pricing.generated.ts`.
 *
 * Unlike Moonshot/Mistral there is NO OpenRouter fallback: the xAI payload
 * carries its own prices (`prompt_text_token_price`,
 * `completion_text_token_price`, `cached_prompt_text_token_price`, in units
 * per 1 token → $ per 1M = raw / 10000). The cached price becomes the
 * catalog's `cacheReadMultiplier` (cached / input), and the long-context
 * fields (`*_long_context`, `long_context_threshold`) become a prompt-length
 * `tiers` entry — both are what the billing engine reads
 * (`selectPricingTier` / `calculateLLMCreditCost` in model-catalog).
 *
 * Uses the live API when XAI_API_KEY is set and the call succeeds; otherwise
 * (no key, or the call fails — the xAI team key has been answering 403 since
 * it ran out of credits) it regenerates from the committed snapshot
 * packages/catalog-sync/snapshots/llm-xai.json, the same `/v1/models`
 * payload `catalog-sync generate --refresh` pins, exactly as
 * sync-anthropic.mjs does. Excludes non-text models (null `context_length` or null token prices,
 * e.g. `grok-imagine-*`).
 */

import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

import { serializeTiers } from "../../packages/catalog-sync/src/sources/openrouter-prompt-tiers.mjs"
import { xaiPricingRow } from "../../packages/catalog-sync/src/sources/xai-pricing.mjs"

const OUTPUT_PATH = resolve(
  import.meta.dirname,
  "../../packages/model-catalog/src/llm/xai-pricing.generated.ts"
)

const SNAPSHOT_PATH = resolve(
  import.meta.dirname,
  "../../packages/catalog-sync/snapshots/llm-xai.json"
)

function readSnapshotModels() {
  return JSON.parse(readFileSync(SNAPSHOT_PATH, "utf-8")).data || []
}

async function fetchXaiModels(apiKey) {
  const res = await fetch("https://api.x.ai/v1/models", {
    headers: { Authorization: `Bearer ${apiKey}` },
  })
  if (!res.ok) {
    throw new Error(
      `xAI Models API returned ${res.status} ${res.statusText}`
    )
  }
  const json = await res.json()
  return json.data || []
}

/** Render one single-line pricing entry, sibling-style. */
function renderEntry(e) {
  const parts = [
    `inputPer1M: ${e.inputPer1M}`,
    `outputPer1M: ${e.outputPer1M}`,
  ]
  if (e.cacheReadMultiplier !== undefined) {
    parts.push(`cacheReadMultiplier: ${e.cacheReadMultiplier}`)
  }
  if (e.tiers) {
    parts.push(serializeTiers(e.tiers))
  }
  parts.push(`vendor: "xai"`, `provider: "xai"`)
  return `  ${JSON.stringify(e.id)}: { ${parts.join(", ")} },`
}

async function main() {
  const apiKey = process.env.XAI_API_KEY
  let models
  let dataSource
  if (apiKey) {
    try {
      console.log("→ Fetching xAI model list (native pricing)…")
      models = await fetchXaiModels(apiKey)
      dataSource = "xAI /v1/models native pricing"
    } catch (err) {
      console.log(`  xAI API failed: ${err.message} — using committed snapshot`)
      dataSource = "llm-xai.json snapshot (xAI API fetch failed)"
    }
  } else {
    console.log("  XAI_API_KEY not set — using committed snapshot")
    dataSource = "llm-xai.json snapshot (XAI_API_KEY unavailable)"
  }
  if (!models) models = readSnapshotModels()
  console.log(`  ${models.length} models from ${dataSource}`)

  const excluded = []
  const entries = []
  for (const m of models) {
    if (!m.id) continue
    // Non-text models (grok-imagine-*): no meaningful token pricing —
    // exclude cleanly instead of crashing on nulls.
    const entry = xaiPricingRow(m)
    if (!entry) {
      excluded.push(m.id)
      continue
    }
    entries.push(entry)
  }
  if (excluded.length) {
    console.log(`  Excluded non-text/unpriced models: ${excluded.join(", ")}`)
  }
  console.log(`  ${entries.length} text models with native pricing kept`)

  // xAI's own /v1/models response declares each model's alternate callable
  // names in its `aliases` array (e.g. grok-4.20-0309-reasoning lists
  // "grok-4.20", "grok-4.20-reasoning", "grok-4.20-beta", ...) — a caller
  // requesting the bare/marketing alias is requesting the SAME priced
  // model, not a different one with an unknown price. Emit every alias as
  // its own priced entry (identical pricing to its canonical id) instead of
  // leaving it to fall through to a hand-typed row or DEFAULT_PRICING.
  // Never overwrites a distinct canonical entry (first-declared alias wins
  // on a cross-model collision; logged so it's visible, not silent).
  const byId = new Map(entries.map((e) => [e.id, e]))
  for (const m of models) {
    if (!m.id || !byId.has(m.id) || !Array.isArray(m.aliases)) continue
    const canonical = byId.get(m.id)
    for (const alias of m.aliases) {
      if (byId.has(alias)) {
        if (byId.get(alias) !== canonical) {
          console.log(`  Alias collision: "${alias}" already priced under a different canonical id — keeping the first one, not ${m.id}`)
        }
        continue
      }
      const aliasEntry = { ...canonical, id: alias }
      entries.push(aliasEntry)
      byId.set(alias, aliasEntry)
    }
  }
  console.log(`  ${entries.length} entries after expanding xAI's own aliases`)

  // Sort alphabetically by id
  entries.sort((a, b) => a.id.localeCompare(b.id))

  const date = new Date().toISOString()
  const header = `// GENERATED FILE — do not edit; regenerate with scripts/catalog-sync/sync-xai.mjs (data: ${dataSource}, synced ${date})
//
// Prices are xAI's NATIVE rates (no OpenRouter passthrough): raw
// \`prompt_text_token_price\` / \`completion_text_token_price\` /
// \`cached_prompt_text_token_price\` are per 1 token → $ per 1M = raw / 10000.
// The cached price is emitted as \`cacheReadMultiplier\` (cached / input) and
// the long-context price (prompts over \`long_context_threshold\`) as \`tiers\`.

import type { LLMPricingTier } from "./catalog.js"

export interface XAIPricingEntry {
  /** $ per 1M input tokens (short-context tier). */
  inputPer1M: number
  /** $ per 1M output tokens (short-context tier). */
  outputPer1M: number
  /** Cached-input price as a multiplier on \`inputPer1M\`. */
  cacheReadMultiplier?: number
  /** Long-context tier: prompts over \`aboveInputTokens\` bill at these rates. */
  tiers?: readonly LLMPricingTier[]
  /** Who authored the model (always "xai"). */
  vendor: "xai"
  /** Route used to call the model (always "xai" — direct SDK). */
  provider: "xai"
}
`

  const body = entries.map(renderEntry).join("\n")

  const file = `${header}\nexport const XAI_GENERATED_PRICING = {\n${body}\n} as const satisfies Record<string, XAIPricingEntry>\n`

  writeFileSync(OUTPUT_PATH, file, "utf-8")
  console.log(`✓ Wrote ${OUTPUT_PATH}`)
  console.log(`  ${entries.length} models written`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

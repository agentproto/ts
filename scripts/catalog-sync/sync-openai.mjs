#!/usr/bin/env node
/**
 * OpenAI catalog sync — ids from OpenAI, prices from OpenAI, OpenRouter as the
 * fallback for both.
 *
 * WHAT CHANGED AND WHY. This script used to take BOTH the id list and the
 * prices from OpenRouter's `openai/*` passthrough, on the stated grounds that
 * "OpenAI publishes NO stable machine-readable models or pricing endpoint".
 * Half of that was never true and the other half stopped being true:
 *
 *   - `GET https://api.openai.com/v1/models` has always existed and is the
 *     authoritative id list. It carries no price and no context window, which
 *     is why it can't be the ONLY source — not a reason to ignore it.
 *   - `https://platform.openai.com/docs/pricing.md` is OpenAI's own Markdown
 *     rendering of the pricing page, served as `text/markdown` and advertised
 *     on the page itself ("Markdown versions of documentation pages are
 *     available by appending `.md` to the page URL"). It is GFM pipe tables
 *     with labelled header rows — parsed here by COLUMN NAME, never by column
 *     position, and never by walking the HTML page's DOM.
 *
 * The merge, the table parser and the id filter are pure functions in
 * `packages/catalog-sync/src/sources/openai-catalog.mjs`, tested without a
 * network by `packages/catalog-sync/src/__tests__/openai-catalog.test.ts`.
 * This file is only the I/O and the console narration.
 *
 * DEGRADATION, in the order it is attempted:
 *   - no `OPENAI_API_KEY`  → ids from OpenRouter only, prices still official
 *                            where the docs page has them. Exit 0, NOT the
 *                            exit-2 "skipped" contract: this script still
 *                            produces a complete, correct file without a key,
 *                            which is why it never claimed one before.
 *   - `/v1/models` errors  → same as no key, with a warning.
 *   - docs page errors, or parses into something that fails
 *     `checkOfficialPricingUsable` (too few rows, sentinel ids missing)
 *                            → every price falls back to OpenRouter and the
 *                            generated banner says so. A page restructure
 *                            must degrade to the old behaviour, never to a
 *                            catalog of wrong numbers.
 *   - OpenRouter errors    → hard failure (exit 1). It is the only fallback;
 *                            silently shipping an official-only catalog would
 *                            drop every `:batch` and `gpt-oss-*` row.
 *
 * Regenerates `packages/model-catalog/src/llm/openai-pricing.generated.ts`.
 */

import { writeFileSync } from "node:fs"
import { resolve } from "node:path"

import {
  buildOpenRouterPriceMap,
  checkOfficialPricingUsable,
  mergeOpenAiCatalog,
  parseOpenAiDocsPricing,
  renderGeneratedFile,
} from "../../packages/catalog-sync/src/sources/openai-catalog.mjs"

const OUTPUT_PATH = resolve(
  import.meta.dirname,
  "../../packages/model-catalog/src/llm/openai-pricing.generated.ts"
)

const OPENAI_MODELS_URL = "https://api.openai.com/v1/models"
const OPENAI_PRICING_DOCS_URL = "https://platform.openai.com/docs/pricing.md"
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models"

/** OpenRouter — the one source whose failure is fatal. */
async function fetchOpenRouterModels() {
  const res = await fetch(OPENROUTER_MODELS_URL)
  if (!res.ok) {
    throw new Error(`OpenRouter Models API returned ${res.status} ${res.statusText}`)
  }
  const json = await res.json()
  return json.data || []
}

/** OpenAI `/v1/models` — returns null (with a warning) on any failure. */
async function fetchOpenAiModelIds(apiKey) {
  try {
    const res = await fetch(OPENAI_MODELS_URL, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    if (!res.ok) {
      console.warn(`  ⚠ OpenAI /v1/models returned ${res.status} ${res.statusText}`)
      return null
    }
    const json = await res.json()
    const ids = (json.data || []).map((model) => model.id).filter((id) => typeof id === "string")
    if (ids.length === 0) {
      console.warn("  ⚠ OpenAI /v1/models returned an empty list")
      return null
    }
    return ids
  } catch (err) {
    console.warn(`  ⚠ OpenAI /v1/models fetch failed: ${err.message}`)
    return null
  }
}

/** Official pricing — returns `{ pricing, note }`, `pricing` null if unusable. */
async function fetchOfficialPricing() {
  try {
    const res = await fetch(OPENAI_PRICING_DOCS_URL, {
      headers: { Accept: "text/markdown, text/plain;q=0.9, */*;q=0.1" },
    })
    if (!res.ok) {
      return { pricing: null, reason: `docs pricing page returned ${res.status} ${res.statusText}` }
    }
    const parsed = parseOpenAiDocsPricing(await res.text())
    const problem = checkOfficialPricingUsable(parsed)
    if (problem) return { pricing: null, reason: problem }
    return { pricing: parsed, reason: null }
  } catch (err) {
    return { pricing: null, reason: `docs pricing page fetch failed: ${err.message}` }
  }
}

async function main() {
  const apiKey = process.env.OPENAI_API_KEY

  let openAiIds = null
  if (apiKey) {
    console.log("→ Fetching OpenAI /v1/models (authoritative id list)…")
    openAiIds = await fetchOpenAiModelIds(apiKey)
    if (openAiIds) console.log(`  ${openAiIds.length} ids received`)
  } else {
    console.log("  OPENAI_API_KEY not set — ids from OpenRouter only (unchanged behaviour).")
  }

  console.log("→ Fetching OpenAI official pricing (platform.openai.com/docs/pricing.md)…")
  const { pricing: officialPricing, reason: officialProblem } = await fetchOfficialPricing()
  if (officialPricing) {
    console.log(
      `  ${officialPricing.standard.size} standard + ${officialPricing.batch.size} batch rows parsed`
    )
  } else {
    console.warn(`  ⚠ official pricing unusable (${officialProblem}) — falling back to OpenRouter`)
  }

  console.log("→ Fetching OpenRouter model list (fallback prices + supplementary ids)…")
  const openRouterModels = await fetchOpenRouterModels()
  const openRouterPrices = buildOpenRouterPriceMap(openRouterModels)
  console.log(`  ${openRouterPrices.size} openai/* routes with pricing`)

  const { entries, unpricedIds } = mergeOpenAiCatalog({
    openAiIds,
    openRouterPrices,
    officialPricing,
  })

  const officialPriced = entries.filter((e) => e.priceSource === "openai").length
  const openRouterOnlyIds = entries.filter((e) => e.idSource === "openrouter").length
  console.log(
    `  ${entries.length} priced rows ` +
      `(${officialPriced} priced by OpenAI, ${entries.length - officialPriced} by OpenRouter)`
  )
  console.log(`  ${openRouterOnlyIds} rows whose id is OpenRouter-only`)
  console.log(`  ${unpricedIds.length} OpenAI-listed ids with no price from either source`)
  console.log(
    `  ${entries.filter((e) => e.cacheReadMultiplier !== undefined).length} with a cache-read multiplier`
  )

  const idSourceLabel = openAiIds
    ? "api.openai.com/v1/models, union openrouter.ai/api/v1/models openai/*"
    : "openrouter.ai/api/v1/models openai/* only (no OPENAI_API_KEY at sync time)"
  const priceSourceLabel = officialPricing
    ? "platform.openai.com/docs/pricing.md, OpenRouter fallback per row"
    : "openrouter.ai/api/v1/models (official pricing unavailable at sync time)"
  const officialPricingNote = officialPricing
    ? undefined
    : `// ⚠ Every price below is OpenRouter's rate, not OpenAI's own: the official\n` +
      `// pricing source could not be used on this run (${officialProblem}).\n` +
      `// OpenRouter rates may differ from OpenAI's first-party pricing.\n`

  const file = renderGeneratedFile({
    entries,
    unpricedIds,
    syncedAt: new Date().toISOString(),
    idSourceLabel,
    priceSourceLabel,
    officialPricingNote,
  })

  writeFileSync(OUTPUT_PATH, file, "utf-8")
  console.log(`✓ Wrote ${OUTPUT_PATH}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

#!/usr/bin/env node
/**
 * GitHub Copilot pricing sync - prices every model the `copilot-cli` harness
 * can run (MAI Code 2 / Flash, the dotted Claude ids, Gemini, Grok, Kimi...)
 * at the rates Copilot itself bills, from the two source files behind
 * docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing
 * (github/docs: `data/tables/copilot/models-and-pricing.yml` for the prices,
 * the page's `.md` for the promo footnotes), parsed by
 * packages/catalog-sync/src/sources/copilot-pricing-table.mjs.
 *
 * Why this source and not another (all probed live 2026-11-18):
 *   - models.dev `github-copilot`: has no `mai-code-2` / `mai-code-2-flash` yet.
 *   - OpenRouter: only `microsoft/phi-4`; no MAI Code.
 *   - Azure Retail Prices (`productName eq 'MAI Models'`): has MAI-Code-2-Flash
 *     (0.05 / 0.25, cache 0.005) but NO row for MAI Code 2, no promo dates, and
 *     opaque meter names.
 *   - api.githubcopilot.com/models: needs a Copilot token (400 without) and
 *     carries no prices.
 *
 * Regenerates `packages/model-catalog/src/llm/copilot-pricing.generated.ts`
 * (wired into the weekly run by run-all.mjs, which globs `sync-*.mjs`).
 *
 * FALLBACK (explicit, never silent): when the source is unreachable or its
 * layout no longer parses, the committed generated file is left untouched, the
 * reason is printed, and the script exits 2 ("skipped on purpose": the weekly
 * job stays green but the log says why prices were not refreshed).
 */
import { existsSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

import {
  checkCopilotPricingUsable,
  parseCopilotPricing,
} from "../../packages/catalog-sync/src/sources/copilot-pricing-table.mjs"
import { serializeTiers } from "../../packages/catalog-sync/src/sources/openrouter-prompt-tiers.mjs"

const RAW = "https://raw.githubusercontent.com/github/docs/main"
const TABLE_URL = `${RAW}/data/tables/copilot/models-and-pricing.yml`
const PAGE_URL = `${RAW}/content/copilot/reference/copilot-billing/models-and-pricing.md`

const OUTPUT_PATH = resolve(
  import.meta.dirname,
  "../../packages/model-catalog/src/llm/copilot-pricing.generated.ts"
)

async function fetchText(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url} returned ${res.status} ${res.statusText}`)
  return res.text()
}

function skip(reason) {
  console.warn(
    `⚠ Copilot pricing NOT refreshed: ${reason}\n` +
      `  ${existsSync(OUTPUT_PATH) ? "committed copilot-pricing.generated.ts kept as is" : "no committed file: Copilot-only ids stay unpriced (the models list will say so)"}`
  )
  process.exit(2)
}

async function main() {
  let table, page
  try {
    ;[table, page] = await Promise.all([fetchText(TABLE_URL), fetchText(PAGE_URL)])
  } catch (err) {
    skip(`fetch failed: ${err.message}`)
  }
  const prices = parseCopilotPricing(table, page)
  const problem = checkCopilotPricingUsable(prices)
  if (problem) skip(problem)

  const date = new Date().toISOString()
  const banner = `// GENERATED FILE — do not edit; regenerate with scripts/catalog-sync/sync-copilot.mjs
// (ids + pricing: github/docs data/tables/copilot/models-and-pricing.yml + the
// promo footnotes of models-and-pricing.md, i.e. GitHub Copilot's own price list;
// ids are Copilot's spelling, e.g. dotted "claude-sonnet-5.5". synced ${date})
// \`promo\`: the row carries the PROMOTIONAL price; \`promo.then\` is the standard
// price from \`promo.until\` on (see effectivePricing in catalog.ts).

`
  const body = [...prices.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, e]) => {
      const parts = [`inputPer1M: ${e.inputPer1M}`, `outputPer1M: ${e.outputPer1M}`]
      if (e.cacheReadMultiplier !== undefined) parts.push(`cacheReadMultiplier: ${e.cacheReadMultiplier}`)
      if (e.cacheWriteMultiplier !== undefined) parts.push(`cacheWriteMultiplier: ${e.cacheWriteMultiplier}`)
      if (e.tiers) parts.push(serializeTiers(e.tiers))
      if (e.promo) parts.push(`promo: ${JSON.stringify(e.promo).replace(/"(\w+)":/g, "$1: ").replace(/,/g, ", ").replace(/\{/g, "{ ").replace(/\}/g, " }")}`)
      parts.push(`priceSource: "github-copilot"`)
      if (e.vendor) parts.push(`vendor: ${JSON.stringify(e.vendor)}`)
      return `  ${JSON.stringify(id)}: { ${parts.join(", ")} },`
    })
    .join("\n")

  writeFileSync(OUTPUT_PATH, `${banner}export const COPILOT_GENERATED_PRICING = {\n${body}\n} as const\n`, "utf-8")
  console.log(`✓ Wrote ${OUTPUT_PATH}\n  ${prices.size} Copilot model ids priced`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})

#!/usr/bin/env node
/**
 * xAI pricing sync — fetches the live model list with NATIVE pricing from
 * `GET https://api.x.ai/v1/models` (Authorization: Bearer $XAI_API_KEY) and
 * regenerates `packages/model-catalog/src/llm/xai-pricing.generated.ts`.
 *
 * Unlike Moonshot/Mistral there is NO OpenRouter fallback: the xAI payload
 * carries its own prices (`prompt_text_token_price`,
 * `completion_text_token_price`, `cached_prompt_text_token_price`, in units
 * per 1 token → $ per 1M = raw / 10000). Long-context tier fields
 * (`*_long_context`, `long_context_threshold`) are captured verbatim but NOT
 * yet consumed by the billing engine.
 *
 * Needs XAI_API_KEY. Exits 2 (skip, not a hard failure) when the key isn't
 * set. Excludes non-text models (null `context_length` or null token prices,
 * e.g. `grok-imagine-*`).
 */

import { writeFileSync } from "node:fs"
import { resolve } from "node:path"

const OUTPUT_PATH = resolve(
  import.meta.dirname,
  "../../packages/model-catalog/src/llm/xai-pricing.generated.ts"
)

/** Raw prices are per 1 token; catalog prices are $ per 1M tokens. */
const PER_1M = 10_000

/** Round to 4 decimal places to avoid floating point artifacts */
function round4(num) {
  return Math.round(num * 10000) / 10000
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
  if (e.cachedInputPer1M != null) {
    parts.push(`cachedInputPer1M: ${e.cachedInputPer1M}`)
  }
  if (e.longContext) {
    const lc = e.longContext
    const lcParts = [
      `inputPer1M: ${lc.inputPer1M}`,
      `outputPer1M: ${lc.outputPer1M}`,
    ]
    if (lc.cachedInputPer1M != null) {
      lcParts.push(`cachedInputPer1M: ${lc.cachedInputPer1M}`)
    }
    lcParts.push(`thresholdTokens: ${lc.thresholdTokens}`)
    parts.push(`longContext: { ${lcParts.join(", ")} }`)
  }
  parts.push(`vendor: "xai"`, `provider: "xai"`)
  return `  ${JSON.stringify(e.id)}: { ${parts.join(", ")} },`
}

async function main() {
  const apiKey = process.env.XAI_API_KEY
  if (!apiKey) {
    console.log(
      "  XAI_API_KEY not set — skipping xAI pricing sync."
    )
    process.exit(2)
  }

  console.log("→ Fetching xAI model list (native pricing)…")
  const models = await fetchXaiModels(apiKey)
  console.log(`  ${models.length} models received`)

  const excluded = []
  const entries = []
  for (const m of models) {
    if (!m.id) continue
    // Non-text models (grok-imagine-*): no meaningful token pricing —
    // exclude cleanly instead of crashing on nulls.
    if (
      m.context_length == null ||
      m.prompt_text_token_price == null ||
      m.completion_text_token_price == null
    ) {
      excluded.push(m.id)
      continue
    }
    const entry = {
      id: m.id,
      inputPer1M: round4(m.prompt_text_token_price / PER_1M),
      outputPer1M: round4(m.completion_text_token_price / PER_1M),
    }
    if (m.cached_prompt_text_token_price != null) {
      entry.cachedInputPer1M = round4(
        m.cached_prompt_text_token_price / PER_1M
      )
    }
    // Long-context tier: captured for reference only (see generated-file
    // banner) — the billing engine does not model it yet.
    if (
      m.prompt_text_token_price_long_context != null &&
      m.completion_text_token_price_long_context != null &&
      m.long_context_threshold != null
    ) {
      entry.longContext = {
        inputPer1M: round4(m.prompt_text_token_price_long_context / PER_1M),
        outputPer1M: round4(
          m.completion_text_token_price_long_context / PER_1M
        ),
        thresholdTokens: m.long_context_threshold,
      }
      if (m.cached_prompt_text_token_price_long_context != null) {
        entry.longContext.cachedInputPer1M = round4(
          m.cached_prompt_text_token_price_long_context / PER_1M
        )
      }
    }
    entries.push(entry)
  }
  if (excluded.length) {
    console.log(`  Excluded non-text/unpriced models: ${excluded.join(", ")}`)
  }
  console.log(`  ${entries.length} text models with native pricing kept`)

  // Sort alphabetically by id
  entries.sort((a, b) => a.id.localeCompare(b.id))

  const date = new Date().toISOString()
  const header = `// GENERATED FILE — do not edit; regenerate with scripts/catalog-sync/sync-xai.mjs (data: xAI /v1/models native pricing, synced ${date})
//
// Prices are xAI's NATIVE rates (no OpenRouter passthrough): raw
// \`prompt_text_token_price\` / \`completion_text_token_price\` /
// \`cached_prompt_text_token_price\` are per 1 token → $ per 1M = raw / 10000.
//
// ⚠ \`longContext\` (tier pricing above \`thresholdTokens\` tokens) is captured
// for reference only — the billing engine does NOT model long-context tiers
// yet (same gap as the Gemini >200k tiers: see \`catalog.ts:172\` and
// \`catalog.ts:204\`).

export interface XAIPricingEntry {
  /** $ per 1M input tokens (short-context tier). */
  inputPer1M: number
  /** $ per 1M output tokens (short-context tier). */
  outputPer1M: number
  /** $ per 1M cached input tokens. */
  cachedInputPer1M?: number
  /**
   * Long-context tier (prompts above \`thresholdTokens\`). CAPTURED BUT NOT
   * YET CONSUMED — the billing engine applies a single price regardless of
   * prompt size (see \`catalog.ts:172\`, \`catalog.ts:204\`).
   */
  longContext?: {
    inputPer1M: number
    outputPer1M: number
    cachedInputPer1M?: number
    thresholdTokens: number
  }
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

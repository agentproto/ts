/**
 * OpenAI catalog merge tests — the openai-ids × official-prices ×
 * openrouter-prices logic behind `scripts/catalog-sync/sync-openai.mjs`.
 *
 * All offline: the docs pricing page is a committed fixture
 * (`fixtures/openai-pricing-docs.md`, a trimmed excerpt of the live page that
 * keeps every structural trap), and the two model lists are literals. The
 * script itself owns the fetching and nothing else, so this covers the part
 * that can be wrong in a way CI can catch.
 */

import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import {
  AMBIGUOUS_BARE_IDS,
  buildOpenRouterPriceMap,
  checkOfficialPricingUsable,
  isOpenAiLlmId,
  lookupOfficialPrice,
  mergeOpenAiCatalog,
  parseDollars,
  parseOpenAiDocsPricing,
  renderGeneratedFile,
} from "../sources/openai-catalog.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))
const DOCS_MARKDOWN = readFileSync(
  join(HERE, "fixtures", "openai-pricing-docs.md"),
  "utf-8"
)

/** Shape of one `openrouter.ai/api/v1/models` row, as much as we read of it. */
function orModel(
  id: string,
  prompt: string,
  completion: string,
  extra: Record<string, string> = {}
) {
  return { id, pricing: { prompt, completion, ...extra } }
}

// ── The docs pricing page parser ───────────────────────────────────────────

describe("parseOpenAiDocsPricing", () => {
  const parsed = parseOpenAiDocsPricing(DOCS_MARKDOWN)

  it("reads the standard tier, including cached-input and cache-write columns", () => {
    expect(parsed.standard.get("gpt-5")).toEqual({
      inputPer1M: 1.25,
      outputPer1M: 10,
      cachedInputPer1M: 0.125,
      cacheWritePer1M: null,
    })
    expect(parsed.standard.get("gpt-6-sol")).toEqual({
      inputPer1M: 2,
      outputPer1M: 10,
      cachedInputPer1M: 0.2,
      cacheWritePer1M: 2.5,
    })
  })

  it("reads the batch tier separately from the standard tier", () => {
    expect(parsed.standard.get("gpt-5")?.inputPer1M).toBe(1.25)
    expect(parsed.batch.get("gpt-5")?.inputPer1M).toBe(0.625)
    expect(parsed.batch.get("gpt-5")?.outputPer1M).toBe(5)
  })

  it("takes the SHORT-context rate, never the long-context columns", () => {
    // gpt-6-astra is $10/$50 short, $20/$75 long.
    expect(parsed.standard.get("gpt-6-astra")).toMatchObject({
      inputPer1M: 10,
      outputPer1M: 50,
    })
  })

  it("strips parenthetical qualifiers from the model cell", () => {
    expect(parsed.standard.get("gpt-5.5")).toMatchObject({ inputPer1M: 5, outputPer1M: 30 })
    expect(parsed.standard.has("gpt-5.5 (<272K context length)")).toBe(false)
  })

  it("reads the specialized-models table, which puts Model in the 2nd column", () => {
    expect(parsed.standard.get("gpt-5.3-codex")).toMatchObject({
      inputPer1M: 1.75,
      outputPer1M: 14,
    })
    expect(parsed.standard.get("chat-latest")).toMatchObject({
      inputPer1M: 5,
      outputPer1M: 30,
    })
  })

  it("ignores the Flex and Fast tiers rather than mistaking them for standard", () => {
    // gpt-4o appears ONLY in standard ($2.50) and fast ($4.25) here.
    expect(parsed.standard.get("gpt-4o")?.inputPer1M).toBe(2.5)
    // gpt-5's standard row must not be overwritten by its flex/fast rows.
    expect(parsed.standard.get("gpt-5")?.inputPer1M).toBe(1.25)
  })

  it("ignores fine-tuning tables, which reuse base ids at fine-tuned rates", () => {
    // The fine-tuning tables price gpt-4.1 at $3.00/$12.00 and gpt-4o at
    // $3.75/$15.00. Reading them would silently inflate the base models.
    expect(parsed.standard.get("gpt-4.1")).toMatchObject({ inputPer1M: 2, outputPer1M: 8 })
    expect(parsed.standard.get("gpt-4o")).toMatchObject({ inputPer1M: 2.5, outputPer1M: 10 })
    expect(parsed.batch.get("gpt-4.1")).toMatchObject({ inputPer1M: 1, outputPer1M: 4 })
    // A fine-tuning-only id must not leak in at all.
    expect(parsed.standard.has("o4-mini-2025-04-16")).toBe(false)
  })

  it("ignores per-modality and non-token tables", () => {
    expect(parsed.standard.has("gpt-realtime-2.1")).toBe(false)
    expect(parsed.standard.has("gpt-live-1")).toBe(false)
  })

  it("drops rows whose price is not a plain dollar amount", () => {
    // "Free" is not $0 for our purposes — it is unparseable, so the row goes.
    expect(parsed.standard.has("omni-moderation-latest")).toBe(false)
    // Embedding rows have "-" for output.
    expect(parsed.standard.has("text-embedding-3-small")).toBe(false)
  })

  it("returns empty tables for a non-string or table-free input", () => {
    expect(parseOpenAiDocsPricing(null).standard.size).toBe(0)
    expect(parseOpenAiDocsPricing("# Pricing\n\nNo tables here.\n").standard.size).toBe(0)
  })
})

describe("parseDollars", () => {
  it("accepts a plain dollar amount", () => {
    expect(parseDollars("$1.75")).toBe(1.75)
    expect(parseDollars(" $0.025 ")).toBe(0.025)
  })

  it("refuses anything carrying a unit or a placeholder", () => {
    for (const cell of ["-", "", "Free", "$100.00 / hour", "$10.00 / 1k calls", "1.75"]) {
      expect(parseDollars(cell)).toBeNull()
    }
  })
})

describe("checkOfficialPricingUsable", () => {
  it("accepts the real page shape", () => {
    expect(checkOfficialPricingUsable(parseOpenAiDocsPricing(DOCS_MARKDOWN))).toBeNull()
  })

  it("rejects an empty or missing parse", () => {
    expect(checkOfficialPricingUsable(null)).toMatch(/no standard-tier rows/)
    expect(checkOfficialPricingUsable(parseOpenAiDocsPricing(""))).toMatch(
      /no standard-tier rows/
    )
  })

  it("rejects a parse that lost the sentinel ids", () => {
    // A page restructure that keeps the table shape but drops the flagship
    // rows must NOT read as "prices went away" — it must read as a break.
    const withoutFlagships = DOCS_MARKDOWN.split("\n")
      .filter(line => !/^\| (gpt-4o|gpt-4\.1) \|/.test(line))
      .join("\n")
    expect(checkOfficialPricingUsable(parseOpenAiDocsPricing(withoutFlagships))).toMatch(
      /sentinel ids: gpt-4o, gpt-4\.1/
    )
  })

  it("rejects a parse with too few rows to be believable", () => {
    const tiny = [
      "### Standard pricing data",
      "",
      "| Model | Input | Output |",
      "| --- | --- | --- |",
      "| gpt-4o | $2.50 | $10.00 |",
      "| gpt-4.1 | $2.00 | $8.00 |",
      "| gpt-5 | $1.25 | $10.00 |",
      "| gpt-5-mini | $0.25 | $2.00 |",
    ].join("\n")
    // All four sentinels present, but only four rows.
    expect(checkOfficialPricingUsable(parseOpenAiDocsPricing(tiny))).toMatch(
      /only 4 standard-tier rows/
    )
  })
})

// ── OpenRouter price map ───────────────────────────────────────────────────

describe("buildOpenRouterPriceMap", () => {
  it("strips the openai/ prefix and scales per-token prices to per-1M", () => {
    const map = buildOpenRouterPriceMap([
      orModel("openai/gpt-4o", "0.0000025", "0.00001"),
      orModel("anthropic/claude-opus-5", "0.000005", "0.000025"),
    ])
    expect(map.get("gpt-4o")).toEqual({ inputPer1M: 2.5, outputPer1M: 10 })
    expect(map.has("claude-opus-5")).toBe(false)
    expect(map.has("anthropic/claude-opus-5")).toBe(false)
  })

  it("derives cache multipliers as ratios against the prompt price", () => {
    const map = buildOpenRouterPriceMap([
      orModel("openai/gpt-5", "0.00000125", "0.00001", {
        input_cache_read: "0.000000125",
        input_cache_write: "0.0000015625",
      }),
    ])
    expect(map.get("gpt-5")).toEqual({
      inputPer1M: 1.25,
      outputPer1M: 10,
      cacheReadMultiplier: 0.1,
      cacheWriteMultiplier: 1.25,
    })
  })

  it("skips rows with no prompt or completion price", () => {
    const map = buildOpenRouterPriceMap([
      { id: "openai/gpt-x", pricing: { prompt: "0.000001" } },
      { id: "openai/gpt-y" },
      null,
    ])
    expect(map.size).toBe(0)
  })
})

// ── Id filtering ───────────────────────────────────────────────────────────

describe("isOpenAiLlmId", () => {
  it("keeps chat, reasoning and codex families", () => {
    for (const id of [
      "gpt-5.4",
      "gpt-6-sol",
      "gpt-5.1-codex-max",
      "gpt-5-chat-latest",
      "o3-mini",
      "gpt-5:batch",
      "gpt-oss-120b",
      "gpt-audio",
    ]) {
      expect(isOpenAiLlmId(id), id).toBe(true)
    }
  })

  it("drops the modalities that live in a sibling catalog or nowhere", () => {
    for (const id of [
      "text-embedding-3-small",
      "omni-moderation-latest",
      "whisper-1",
      "tts-1-hd",
      "gpt-realtime-2.1",
      "gpt-image-2",
      "gpt-5.4-image-2",
      "sora-2-pro",
      "gpt-live-1",
      "babbage-002",
      "davinci-002",
      "gpt-4o-transcribe",
    ]) {
      expect(isOpenAiLlmId(id), id).toBe(false)
    }
  })

  it("keeps the two curated image-capable chat exceptions", () => {
    // No digit after "image" — `spawn-model-eligibility` depends on these
    // staying routable.
    expect(isOpenAiLlmId("gpt-5-image")).toBe(true)
    expect(isOpenAiLlmId("gpt-5-image-mini")).toBe(true)
  })
})

// ── Official price lookup ──────────────────────────────────────────────────

describe("lookupOfficialPrice", () => {
  const official = parseOpenAiDocsPricing(DOCS_MARKDOWN)

  it("converts cached-input and cache-write dollars into multipliers", () => {
    expect(lookupOfficialPrice("gpt-6-sol", official)).toEqual({
      inputPer1M: 2,
      outputPer1M: 10,
      cacheReadMultiplier: 0.1,
      cacheWriteMultiplier: 1.25,
    })
  })

  it("prices a :batch id from the batch table under its base id", () => {
    expect(lookupOfficialPrice("gpt-5:batch", official)).toEqual({
      inputPer1M: 0.625,
      outputPer1M: 5,
      cacheReadMultiplier: 0.1,
    })
  })

  it("does not fall back to the standard table for an unlisted :batch id", () => {
    // gpt-5.6-sol is in standard but not in this fixture's batch table.
    expect(lookupOfficialPrice("gpt-5.6-sol", official)).not.toBeNull()
    expect(lookupOfficialPrice("gpt-5.6-sol:batch", official)).toBeNull()
  })

  it("returns null for an unknown id or a missing table", () => {
    expect(lookupOfficialPrice("gpt-nonexistent", official)).toBeNull()
    expect(lookupOfficialPrice("gpt-5", null)).toBeNull()
  })
})

// ── The merge ──────────────────────────────────────────────────────────────

describe("mergeOpenAiCatalog", () => {
  const official = parseOpenAiDocsPricing(DOCS_MARKDOWN)
  const openRouterPrices = buildOpenRouterPriceMap([
    // Deliberately DISAGREES with the docs page ($4.00/$20.00) so the
    // official-first precedence is observable, not just asserted.
    orModel("openai/gpt-5.6-sol", "0.000002", "0.00001"),
    orModel("openai/gpt-5", "0.00000125", "0.00001"),
    orModel("openai/gpt-5:batch", "0.000001", "0.000008"),
    orModel("openai/gpt-5.1-codex", "0.00000125", "0.00001", {
      input_cache_read: "0.000000125",
    }),
    orModel("openai/gpt-oss-120b", "0.00000015", "0.0000006"),
    orModel("openai/gpt-image-2", "0.00001", "0.00001"),
  ])

  const openAiIds = [
    "gpt-5",
    "gpt-5.6-sol",
    "gpt-5.1-codex",
    "gpt-5.4-2026-03-05", // dated snapshot: neither source prices it
    "chat-latest", // officially priced, but too generic for a pricing key
    "whisper-1", // filtered out as a non-LLM modality
  ]

  it("prefers official prices and records the source per row", () => {
    const { entries } = mergeOpenAiCatalog({ openAiIds, openRouterPrices, officialPricing: official })
    const byId = Object.fromEntries(entries.map(e => [e.id, e]))

    expect(byId["gpt-5.6-sol"]).toMatchObject({
      inputPer1M: 4, // docs page, NOT OpenRouter's 2
      outputPer1M: 20,
      priceSource: "openai",
    })
    expect(byId["gpt-5"]).toMatchObject({ inputPer1M: 1.25, priceSource: "openai" })
  })

  it("falls back to OpenRouter for an id the docs page does not price", () => {
    const { entries } = mergeOpenAiCatalog({ openAiIds, openRouterPrices, officialPricing: official })
    const codex = entries.find(e => e.id === "gpt-5.1-codex")
    expect(codex).toMatchObject({
      inputPer1M: 1.25,
      outputPer1M: 10,
      cacheReadMultiplier: 0.1,
      priceSource: "openrouter",
      idSource: "openai",
    })
  })

  it("keeps OpenRouter-only ids, flagged idSource openrouter", () => {
    const { entries } = mergeOpenAiCatalog({ openAiIds, openRouterPrices, officialPricing: official })
    // `:batch` is a separate endpoint and `gpt-oss-*` is open-weights —
    // neither can ever appear in /v1/models, so neither may be dropped.
    expect(entries.find(e => e.id === "gpt-5:batch")).toMatchObject({
      idSource: "openrouter",
      priceSource: "openai", // still officially priced, via the batch table
      inputPer1M: 0.625,
    })
    expect(entries.find(e => e.id === "gpt-oss-120b")).toMatchObject({
      idSource: "openrouter",
      priceSource: "openrouter",
    })
  })

  it("lists an OpenAI id neither source prices instead of inventing a zero", () => {
    const { entries, unpricedIds } = mergeOpenAiCatalog({
      openAiIds,
      openRouterPrices,
      officialPricing: official,
    })
    expect(unpricedIds).toContain("gpt-5.4-2026-03-05")
    expect(entries.some(e => e.id === "gpt-5.4-2026-03-05")).toBe(false)
    // Nothing anywhere in the output is priced at zero.
    expect(entries.every(e => e.inputPer1M > 0 && e.outputPer1M > 0)).toBe(true)
  })

  it("holds back an ambiguous bare id from pricing but keeps it known", () => {
    const { entries, unpricedIds } = mergeOpenAiCatalog({
      openAiIds,
      openRouterPrices,
      officialPricing: official,
    })
    expect(AMBIGUOUS_BARE_IDS.has("chat-latest")).toBe(true)
    expect(entries.some(e => e.id === "chat-latest")).toBe(false)
    expect(unpricedIds).toContain("chat-latest")
  })

  it("applies the modality filter to both id sources", () => {
    const { entries, unpricedIds } = mergeOpenAiCatalog({
      openAiIds,
      openRouterPrices,
      officialPricing: official,
    })
    expect(entries.some(e => e.id === "whisper-1")).toBe(false)
    expect(unpricedIds).not.toContain("whisper-1")
    expect(entries.some(e => e.id === "gpt-image-2")).toBe(false)
  })

  it("sorts rows and unpriced ids by id", () => {
    const { entries, unpricedIds } = mergeOpenAiCatalog({
      openAiIds,
      openRouterPrices,
      officialPricing: official,
    })
    const ids = entries.map(e => e.id)
    expect(ids).toEqual([...ids].sort((a, b) => a.localeCompare(b)))
    expect(unpricedIds).toEqual([...unpricedIds].sort((a, b) => a.localeCompare(b)))
  })

  // ── Degradation paths ────────────────────────────────────────────────────

  it("without an OpenAI key, ids come from OpenRouter alone and nothing is unpriced", () => {
    const { entries, unpricedIds } = mergeOpenAiCatalog({
      openAiIds: null,
      openRouterPrices,
      officialPricing: official,
    })
    expect(unpricedIds).toEqual([])
    expect(entries.every(e => e.idSource === "openrouter")).toBe(true)
    // Every OpenRouter route still shows up (minus the modality filter).
    expect(entries.map(e => e.id).sort()).toEqual([
      "gpt-5",
      "gpt-5.1-codex",
      "gpt-5.6-sol",
      "gpt-5:batch",
      "gpt-oss-120b",
    ])
  })

  it("without official pricing, every row falls back to OpenRouter", () => {
    const { entries } = mergeOpenAiCatalog({
      openAiIds,
      openRouterPrices,
      officialPricing: null,
    })
    expect(entries.every(e => e.priceSource === "openrouter")).toBe(true)
    // …including the row where the two sources disagreed.
    expect(entries.find(e => e.id === "gpt-5.6-sol")).toMatchObject({
      inputPer1M: 2,
      outputPer1M: 10,
    })
  })

  it("prices from the docs page alone when OpenRouter yields nothing", () => {
    const { entries } = mergeOpenAiCatalog({
      openAiIds,
      openRouterPrices: new Map(),
      officialPricing: official,
    })
    expect(entries.map(e => e.id).sort()).toEqual(["gpt-5", "gpt-5.6-sol"])
    expect(entries.every(e => e.priceSource === "openai")).toBe(true)
  })

  it("produces nothing rather than throwing when every source is empty", () => {
    expect(mergeOpenAiCatalog({})).toEqual({ entries: [], unpricedIds: [] })
  })
})

// ── Rendering ──────────────────────────────────────────────────────────────

describe("renderGeneratedFile", () => {
  const rendered = renderGeneratedFile({
    entries: [
      {
        id: "gpt-5",
        inputPer1M: 1.25,
        outputPer1M: 10,
        cacheReadMultiplier: 0.1,
        priceSource: "openai",
        idSource: "openai",
      },
      {
        id: "gpt-5:batch",
        inputPer1M: 0.625,
        outputPer1M: 5,
        priceSource: "openai",
        idSource: "openrouter",
      },
    ],
    unpricedIds: ["gpt-5.4-2026-03-05"],
    syncedAt: "2026-09-25T00:00:00.000Z",
    idSourceLabel: "api.openai.com/v1/models",
    priceSourceLabel: "platform.openai.com/docs/pricing.md",
  })

  it("emits both exports with vendor/provider and the provenance fields", () => {
    expect(rendered).toContain(
      `  "gpt-5": { inputPer1M: 1.25, outputPer1M: 10, cacheReadMultiplier: 0.1, vendor: "openai", provider: "openai", priceSource: "openai", idSource: "openai" },`
    )
    expect(rendered).toContain(
      `  "gpt-5:batch": { inputPer1M: 0.625, outputPer1M: 5, vendor: "openai", provider: "openai", priceSource: "openai", idSource: "openrouter" },`
    )
    expect(rendered).toContain("export const OPENAI_GENERATED_PRICING = {")
    expect(rendered).toContain("export const OPENAI_GENERATED_UNPRICED_IDS = [")
    expect(rendered).toContain(`  "gpt-5.4-2026-03-05",`)
  })

  it("records in the banner what actually sourced this run", () => {
    expect(rendered).toContain("ids: api.openai.com/v1/models")
    expect(rendered).toContain("prices: platform.openai.com/docs/pricing.md")
    expect(rendered).toContain("synced 2026-09-25T00:00:00.000Z")
    // No OpenRouter-fallback warning when official pricing was used.
    expect(rendered).not.toContain("Every price below is OpenRouter's rate")
  })

  it("carries the fallback warning through when official pricing was unusable", () => {
    const degraded = renderGeneratedFile({
      entries: [],
      unpricedIds: [],
      syncedAt: "2026-09-25T00:00:00.000Z",
      idSourceLabel: "openrouter.ai/api/v1/models openai/* only",
      priceSourceLabel: "openrouter.ai/api/v1/models",
      officialPricingNote: "// ⚠ docs pricing page returned 503\n",
    })
    expect(degraded).toContain("docs pricing page returned 503")
    // Empty inputs must still render syntactically valid TypeScript.
    expect(degraded).toContain("export const OPENAI_GENERATED_PRICING = {} as const")
    expect(degraded).toContain("export const OPENAI_GENERATED_UNPRICED_IDS = [] as const")
  })

  it("renders the empty unpriced list `as const`, never as `readonly string[]`", () => {
    // Not cosmetic. `LlmModelId` unions in
    // `(typeof OPENAI_GENERATED_UNPRICED_IDS)[number]`; for `readonly string[]`
    // that index is plain `string`, so the whole union collapses to `string`
    // and every model-id typo check in the repo goes quiet. `readonly []`
    // indexes to `never`, which unions harmlessly. The empty branch is
    // reachable on any sync run without `OPENAI_API_KEY`.
    const empty = renderGeneratedFile({
      entries: [],
      unpricedIds: [],
      syncedAt: "2026-09-25T00:00:00.000Z",
      idSourceLabel: "openrouter.ai/api/v1/models openai/* only",
      priceSourceLabel: "openrouter.ai/api/v1/models",
    })
    expect(empty).toContain("export const OPENAI_GENERATED_UNPRICED_IDS = [] as const")
    expect(empty).not.toContain("as readonly string[]")
  })
})

import { z } from "zod"

import { defineGenerator, type GeneratedFiles, type GeneratorContext } from "../types.js"
import {
  computeAddedAtLedger,
  isoDateFromUnixSeconds,
  ledgerRelPath,
  readLedger,
  serializeLedger,
  todayIso,
} from "../added-at.js"

/**
 * PINNED source. The Requesty `/v1/models` payload lists every route the
 * router exposes with per-token USD pricing. We never fetch it at build or
 * test time — only behind `--refresh`, which writes
 * `snapshots/llm-requesty.json` so the next offline run is deterministic.
 * Live fetch requires `Authorization: Bearer $REQUESTY_API_KEY` (see
 * `sources` below) — without the key set, the framework reuses the
 * committed snapshot rather than fetching unauthenticated.
 */
const REQUESTY_MODELS_URL = "https://router.requesty.ai/v1/models"

/** Repo-relative drop-in target for {@link @agentproto/model-catalog}. */
const OUTPUT_PATH = "packages/model-catalog/src/llm/requesty-routes.generated.ts"

// ── Source schema ────────────────────────────────────────────────────────
// UNLIKE OpenRouter, Requesty prices are JSON **numbers** in USD-PER-TOKEN
// (e.g. `4e-7` = $0.40/1M), not strings, and live flat on the model entry
// rather than nested under a `pricing` object. `cached_price` is a cache
// READ price (no cache-write price exists in this source — we never emit
// `cacheWriteMultiplier`). `supports_caching` gates whether `cached_price`
// is actually meaningful: some entries carry a non-zero `cached_price` with
// `supports_caching: false` (cache pricing published but not offered), so
// the multiplier must only be derived when the flag is true. passthrough()
// keeps the other live keys (context_window, supports_vision, description,
// …) forward-compatible without a regenerate — we only read what we model.

// `created` is Unix seconds — Requesty's own route-creation timestamp, used
// to backfill `addedAt` for ids not already in the ledger (see
// `../added-at.ts`). Verified present on the live payload (2026-08-31).
const ModelSchema = z
  .object({
    id: z.string(),
    input_price: z.number().optional(),
    output_price: z.number().optional(),
    cached_price: z.number().optional(),
    supports_caching: z.boolean().optional(),
    created: z.number().optional(),
  })
  .passthrough()

const SnapshotSchema = z.object({
  data: z.array(ModelSchema),
})

// ── Output shape (mirrors model-catalog's LLMPricing) ────────────────────
// Drop-in for `packages/model-catalog/src/llm/requesty-routes.generated.ts`.
// Structurally identical to LLMPricing — inputPer1M / outputPer1M in USD per
// 1M tokens, plus cacheReadMultiplier when the source carries a meaningful
// `cached_price`. No `cacheWriteMultiplier` — Requesty has no cache-write
// price to derive one from.

interface LLMPricingEntry {
  inputPer1M: number
  outputPer1M: number
  cacheReadMultiplier?: number
  /** ISO date this id was first seen by a sync run. See `../added-at.ts`. */
  addedAt?: string
  vendor: string
  provider: "requesty"
}

// ── Number helpers ──────────────────────────────────────────────────────

/** Round to 6 decimal places, killing binary-float noise from the per-token × 1e6 product. */
function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000
}

/**
 * Convert a per-token USD number to USD-per-1M-tokens, or undefined if
 * unpriced. UNLIKE OpenRouter (per-token USD strings), Requesty already
 * gives per-token USD as a JSON number, so there's no `Number(...)` parse
 * step — just the same ×1e6 + round6 normalization.
 */
function per1m(tokenPrice: number | undefined): number | undefined {
  if (tokenPrice === undefined) return undefined
  if (!Number.isFinite(tokenPrice)) return undefined
  return round6(tokenPrice * 1_000_000)
}

/** Shortest faithful decimal string (matches existing file: 1, 0.5, 0.7448, 1.25). */
function fmt(n: number): string {
  if (!Number.isFinite(n)) return "0"
  return `${round6(n)}`
}

/** Vendor slug = first segment of the Requesty route id (`vendor/model`). */
function vendorOf(id: string): string {
  if (!id.includes("/")) return id
  return id.split("/")[0] ?? id
}

// ── Serialization ────────────────────────────────────────────────────────

function serializeEntry(e: LLMPricingEntry): string {
  const fields: string[] = [
    `inputPer1M: ${fmt(e.inputPer1M)}`,
    `outputPer1M: ${fmt(e.outputPer1M)}`,
  ]
  if (e.cacheReadMultiplier !== undefined) {
    fields.push(`cacheReadMultiplier: ${fmt(e.cacheReadMultiplier)}`)
  }
  if (e.addedAt !== undefined) {
    fields.push(`addedAt: ${JSON.stringify(e.addedAt)}`)
  }
  fields.push(`vendor: ${JSON.stringify(e.vendor)}`)
  fields.push(`provider: ${JSON.stringify(e.provider)}`)
  return `{\n    ${fields.join(",\n    ")},\n  }`
}

function serializeFile(entries: Record<string, LLMPricingEntry>): string {
  const ids = Object.keys(entries).sort()
  const providers = Array.from(new Set(ids.map(vendorOf))).sort()

  const lines: string[] = [
    "// AUTO-GENERATED by @agentproto/catalog-sync (llm:requesty).",
    "// Do not edit by hand — re-run `pnpm --filter @agentproto/catalog-sync generate`.",
    `// Source: ${REQUESTY_MODELS_URL}`,
    "// Pricing carries provider USD (inputPer1M / outputPer1M) plus a cache",
    "// multiplier (cacheReadMultiplier) derived from the source's cached_price",
    "// per-token field when `supports_caching` is true. Requesty has no",
    "// cache-write price, so cacheWriteMultiplier is never emitted.",
    "// addedAt is the ISO date this id was first seen by a sync run — backfilled",
    "// from the source's own `created` timestamp, then NEVER mutated; see",
    "// packages/catalog-sync/src/added-at.ts and the package README.",
    "",
    'import type { LLMPricing } from "./catalog.js"',
    "",
    "export const REQUESTY_ROUTES: Record<string, LLMPricing> = {",
  ]
  for (const id of ids) {
    lines.push(`  ${JSON.stringify(id)}: ${serializeEntry(entries[id]!)},`)
  }
  lines.push("}")
  lines.push("")
  lines.push("/** Provider slugs treated as Requesty routes by the picker. */")
  lines.push("export const REQUESTY_PROVIDERS: readonly string[] = [")
  for (const p of providers) {
    lines.push(`  ${JSON.stringify(p)},`)
  }
  lines.push("]")
  lines.push("")
  return lines.join("\n")
}

// ── Generator ───────────────────────────────────────────────────────────

const LEDGER_ID = "llm-requesty"

async function generate(ctx: GeneratorContext): Promise<GeneratedFiles> {
  const src = sources[0]
  if (!src) throw new Error("llm:requesty: no source configured")
  const parsed = SnapshotSchema.parse(await ctx.fetchSource(src))

  const entries: Record<string, LLMPricingEntry> = {}
  const createdAt: Record<string, string> = {}
  for (const model of parsed.data) {
    const inputPer1M = per1m(model.input_price)
    const outputPer1M = per1m(model.output_price)
    if (inputPer1M === undefined || outputPer1M === undefined) continue
    // Skip unpriced routes.
    if (inputPer1M === 0 && outputPer1M === 0) continue

    const entry: LLMPricingEntry = {
      inputPer1M,
      outputPer1M,
      vendor: vendorOf(model.id),
      provider: "requesty",
    }

    if (model.supports_caching === true && inputPer1M > 0) {
      const cachePer1M = per1m(model.cached_price)
      if (cachePer1M !== undefined) {
        entry.cacheReadMultiplier = round6(cachePer1M / inputPer1M)
      }
    }

    entries[model.id] = entry
    if (model.created !== undefined) createdAt[model.id] = isoDateFromUnixSeconds(model.created)
  }

  const ledger = computeAddedAtLedger(
    Object.keys(entries),
    readLedger(LEDGER_ID),
    createdAt,
    todayIso()
  )
  for (const [id, entry] of Object.entries(entries)) entry.addedAt = ledger[id]

  return {
    [OUTPUT_PATH]: serializeFile(entries),
    [ledgerRelPath(LEDGER_ID)]: serializeLedger(ledger),
  }
}

const sources = [
  {
    id: "llm-requesty",
    url: REQUESTY_MODELS_URL,
    // Live refresh needs the account key (Bearer). Without REQUESTY_API_KEY
    // set, the framework reuses the committed snapshot.
    headers: { Authorization: "Bearer env:REQUESTY_API_KEY" },
  },
]

export const llmRequestyGenerator = defineGenerator({
  name: "llm:requesty",
  modality: "llm",
  sources,
  generate,
})

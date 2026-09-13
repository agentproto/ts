import { z } from "zod"

import { defineGenerator, type GeneratedFiles, type GeneratorContext } from "../types.js"
import {
  computeAddedAtLedger,
  ledgerRelPath,
  readLedger,
  serializeLedger,
  todayIso,
} from "../added-at.js"

/**
 * OpenCode's two hosted billing endpoints, both sourced from models.dev.
 *
 *   - `opencode-go`  — OpenCode Go, the flat $10/mo API-key subscription.
 *   - `opencode`     — OpenCode Zen, the pay-as-you-go sibling.
 *
 * They are DIFFERENT endpoints with different per-model prices and different
 * model lineups (Go serves no Claude/Gemini; Zen serves both), so each gets
 * its own generator, ledger, snapshot and route table. They only share a
 * source URL and an env var name (`OPENCODE_API_KEY` — see the note in
 * `@agentproto/model-catalog`'s `PROVIDER_KEY_ENV`: same name, two distinct
 * secrets).
 *
 * PINNED source. models.dev's `api.json` is the whole ecosystem's catalog
 * (~4.6 MB, 213 providers) and is fetched UNAUTHENTICATED — unlike Requesty,
 * there is no key to gate the refresh on, so `sources` carries no headers and
 * `--refresh` always hits the live URL.
 *
 * Because the payload is 4.6 MB and we model two providers out of 213, the
 * committed snapshot is a PROJECTION, not the raw response: each generator
 * emits `snapshots/<ledger-id>.json` as one of its {@link GeneratedFiles},
 * narrowed to its own provider and to the fields below, with deterministic key
 * order. The runner's `--refresh` writes the raw response to that path first
 * and this projection immediately overwrites it in the same run, so a refresh
 * never leaves 4.6 MB of unrelated providers in the tree. The projection keeps
 * the SOURCE's own shape (nested `provider.npm`, nested `cost`), so
 * {@link SnapshotSchema} parses the raw payload and the committed projection
 * identically and re-projecting a projection is a no-op.
 */
const MODELS_DEV_URL = "https://models.dev/api.json"

// ── Source schema ────────────────────────────────────────────────────────
// Everything is optional + passthrough: this schema is applied to the FULL
// models.dev payload (213 providers), so one unrelated provider drifting a
// field must not break our two generators. Prices are USD **per 1M tokens
// ALREADY** (`cost.input: 1.4` = $1.40/1M) — unlike Requesty's per-token
// numbers, so there is no ×1e6 conversion here. `cost.cache_read` /
// `cost.cache_write` are absolute per-1M prices too, from which the
// multipliers are derived. `cost.tiers` / `cost.context_over_200k` exist on
// some entries and are deliberately NOT modelled: LLMPricing has no tiered
// shape, and inventing one from an un-consumed field would be fabricated
// pricing.

const ModelSchema = z
  .object({
    id: z.string().optional(),
    name: z.string().optional(),
    family: z.string().optional(),
    /** ISO `YYYY-MM-DD` already — no unix-seconds conversion (cf. Requesty). */
    release_date: z.string().optional(),
    provider: z
      .object({
        /** Which AI-SDK package serves this model — the ONLY discriminator
         *  for the endpoint's three wire surfaces (see
         *  {@link anthropicSurfaceIds}). */
        npm: z.string().optional(),
      })
      .passthrough()
      .optional(),
    cost: z
      .object({
        input: z.number().optional(),
        output: z.number().optional(),
        cache_read: z.number().optional(),
        cache_write: z.number().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()

type SourceModel = z.infer<typeof ModelSchema>

const ProviderSchema = z
  .object({
    id: z.string().optional(),
    name: z.string().optional(),
    /** The endpoint's base URL, e.g. `https://opencode.ai/zen/go/v1`. */
    api: z.string().optional(),
    doc: z.string().optional(),
    env: z.array(z.string()).optional(),
    npm: z.string().optional(),
    models: z.record(z.string(), ModelSchema).optional(),
  })
  .passthrough()

type SourceProvider = z.infer<typeof ProviderSchema>

/** models.dev's whole payload is `{ [providerId]: provider }`; a committed
 *  projection is the same map narrowed to one key. */
const SnapshotSchema = z.record(z.string(), ProviderSchema)

// ── Output shape (mirrors model-catalog's LLMPricing) ────────────────────

interface LLMPricingEntry {
  inputPer1M: number
  outputPer1M: number
  cacheReadMultiplier?: number
  cacheWriteMultiplier?: number
  /** ISO date this id was first seen by a sync run. See `../added-at.ts`. */
  addedAt?: string
  vendor: string
  provider: string
}

// ── Number helpers ──────────────────────────────────────────────────────

/** Round to 6 decimal places, killing binary-float noise from the division. */
function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000
}

/** Shortest faithful decimal string (matches the other generated files). */
function fmt(n: number): string {
  if (!Number.isFinite(n)) return "0"
  return `${round6(n)}`
}

/**
 * A cache price relative to the base input price. Only meaningful when the
 * base price is positive: every `-free` variant on Zen carries
 * `cost.input: 0` alongside `cost.cache_read: 0`, and 0/0 is NaN — a free
 * model has no cache DISCOUNT to express, so no multiplier is emitted.
 */
function cacheMultiplier(
  cachePer1M: number | undefined,
  inputPer1M: number
): number | undefined {
  if (cachePer1M === undefined || !Number.isFinite(cachePer1M)) return undefined
  if (inputPer1M <= 0) return undefined
  return round6(cachePer1M / inputPer1M)
}

// ── Vendor attribution ──────────────────────────────────────────────────

/**
 * Model id prefix → vendor (who BUILT the model), matched in order.
 *
 * HEURISTIC by necessity: models.dev's opencode/opencode-go entries carry
 * BARE product ids (`glm-5.3`, not `z-ai/glm-5.3`) and no vendor field at
 * all — `family` is a product line (`glm`, `deepseek-flash`), not a builder.
 * Each slug below is the one the repo's own catalog already uses for that
 * builder (verified against `OPENROUTER_ROUTES`' `vendor` values, which is
 * why it's `x-ai` and not `xai`, `moonshotai` and not `moonshot`), and each
 * attribution was cross-checked against another models.dev provider that
 * namespaces the SAME id under its builder (`inclusionai/ling-3.0-flash`,
 * `nvidia/nemotron-3-super-…`, `arcee-ai/trinity-large-…`,
 * `poolside/laguna-s-2.1`, `cohere/north-mini-code`, `meta/muse-spark-1.2`).
 * A new id that matches nothing here falls back to `opencode` — the handful
 * of unattributed ids on these endpoints (`omen-alpha`, `ox-alpha-free`,
 * `big-pickle`, `x-preview-f-free`) are opencode's own stealth/preview
 * models with no disclosed builder.
 *
 * `vendor` is METADATA on the pricing entry. It is NOT the route key: the
 * route tables are keyed `<provider>/<bare-id>` (see {@link routeKey}), so a
 * mis-attributed vendor can never mis-route or mis-bill a spawn.
 */
const VENDOR_BY_ID_PREFIX: ReadonlyArray<readonly [RegExp, string]> = [
  [/^claude-/, "anthropic"],
  [/^gemini-/, "google"],
  [/^gpt-/, "openai"],
  [/^grok-/, "x-ai"],
  [/^glm-/, "z-ai"],
  [/^kimi-/, "moonshotai"],
  [/^deepseek-/, "deepseek"],
  [/^minimax-/, "minimax"],
  [/^qwen/, "qwen"],
  [/^mimo-/, "xiaomi"],
  [/^hy\d/, "tencent"],
  [/^longcat-/, "meituan"],
  [/^(ling|ring)-/, "inclusionai"],
  [/^nemotron-/, "nvidia"],
  [/^trinity-/, "arcee-ai"],
  [/^laguna-/, "poolside"],
  [/^north-/, "cohere"],
  [/^muse-spark-/, "meta"],
]

/** Vendor for a bare model id — see {@link VENDOR_BY_ID_PREFIX}. */
export function vendorForOpencodeModelId(bareId: string): string {
  for (const [pattern, vendor] of VENDOR_BY_ID_PREFIX) {
    if (pattern.test(bareId)) return vendor
  }
  return "opencode"
}

// ── Serialization ────────────────────────────────────────────────────────

/**
 * Route-table key: `<provider>/<bare-id>` — `opencode-go/glm-5.3`,
 * `opencode/claude-sonnet-4-6`.
 *
 * Deliberately NOT `<vendor>/<product>` like the OpenRouter / Requesty
 * tables. Those routers namespace their own ids by vendor, so their keys
 * round-trip through route-identity's `vendor/product@route` grammar.
 * models.dev gives these two endpoints BARE ids, and opencode's own config
 * spells them `opencode-go/glm-5.3` — which is also the form the runtime
 * derives the billing endpoint from (`modelIdPrefixProvider`) and the form
 * the opencode adapter puts on the wire. Keying by the provider makes all
 * three agree on one string, and `route-identity`'s opencode branches key
 * off exactly this (see the comment there for why they must run ahead of the
 * direct-vendor branch).
 */
function routeKey(provider: string, bareId: string): string {
  return `${provider}/${bareId}`
}

function serializeEntry(e: LLMPricingEntry): string {
  const fields: string[] = [
    `inputPer1M: ${fmt(e.inputPer1M)}`,
    `outputPer1M: ${fmt(e.outputPer1M)}`,
  ]
  if (e.cacheReadMultiplier !== undefined) {
    fields.push(`cacheReadMultiplier: ${fmt(e.cacheReadMultiplier)}`)
  }
  if (e.cacheWriteMultiplier !== undefined) {
    fields.push(`cacheWriteMultiplier: ${fmt(e.cacheWriteMultiplier)}`)
  }
  if (e.addedAt !== undefined) {
    fields.push(`addedAt: ${JSON.stringify(e.addedAt)}`)
  }
  fields.push(`vendor: ${JSON.stringify(e.vendor)}`)
  fields.push(`provider: ${JSON.stringify(e.provider)}`)
  return `{\n    ${fields.join(",\n    ")},\n  }`
}

/** One endpoint's identity — everything the emitted files need to describe it. */
interface OpencodeEndpoint {
  /** models.dev provider key, and this repo's `CatalogProvider` value. */
  providerKey: string
  /** Generator + snapshot + ledger id. */
  ledgerId: string
  /** `llm:<name>` generator name. */
  generatorName: string
  /** Repo-relative emitted route table. */
  outputPath: string
  /** Exported route-table const. */
  routesConst: string
  /** Exported Anthropic-surface id list const. */
  anthropicConst: string
  /** Human label, used only in generated comments. */
  label: string
}

const GO: OpencodeEndpoint = {
  providerKey: "opencode-go",
  ledgerId: "llm-opencode-go",
  generatorName: "llm:opencode-go",
  outputPath: "packages/model-catalog/src/llm/opencode-go-routes.generated.ts",
  routesConst: "OPENCODE_GO_ROUTES",
  anthropicConst: "OPENCODE_GO_ANTHROPIC_MODELS",
  label: "OpenCode Go",
}

const ZEN: OpencodeEndpoint = {
  providerKey: "opencode",
  ledgerId: "llm-opencode-zen",
  generatorName: "llm:opencode-zen",
  outputPath: "packages/model-catalog/src/llm/opencode-zen-routes.generated.ts",
  routesConst: "OPENCODE_ZEN_ROUTES",
  anthropicConst: "OPENCODE_ZEN_ANTHROPIC_MODELS",
  label: "OpenCode Zen",
}

function serializeFile(
  endpoint: OpencodeEndpoint,
  entries: Record<string, LLMPricingEntry>,
  anthropicIds: readonly string[]
): string {
  const keys = Object.keys(entries).sort()

  const lines: string[] = [
    `// AUTO-GENERATED by @agentproto/catalog-sync (${endpoint.generatorName}).`,
    "// Do not edit by hand — re-run `pnpm --filter @agentproto/catalog-sync generate`.",
    `// Source: ${MODELS_DEV_URL} (provider "${endpoint.providerKey}" — ${endpoint.label})`,
    "// Prices come VERBATIM from the source's cost.input / cost.output, which",
    "// models.dev already publishes as USD per 1M tokens (no per-token",
    "// conversion, unlike the Requesty table). cacheReadMultiplier /",
    "// cacheWriteMultiplier are cost.cache_read / cost.cache_write expressed",
    "// relative to cost.input, and are omitted when the base input price is 0",
    "// (every `-free` variant) because a free model has no cache discount.",
    "// Zero-priced models are KEPT — on these endpoints zero is the truth, not",
    "// a missing price.",
    "// Keys are `<provider>/<bare-id>`, the form opencode's own config uses and",
    "// the form the runtime derives the billing endpoint from; `vendor` is a",
    "// heuristic attribution of the model's BUILDER and is metadata only.",
    "// addedAt is the ISO date this id was first seen by a sync run — backfilled",
    "// from the source's own `release_date`, then NEVER mutated; see",
    "// packages/catalog-sync/src/added-at.ts and the package README.",
    "",
    'import type { LLMPricing } from "./catalog.js"',
    "",
    `export const ${endpoint.routesConst}: Record<string, LLMPricing> = {`,
  ]
  for (const key of keys) {
    lines.push(`  ${JSON.stringify(key)}: ${serializeEntry(entries[key]!)},`)
  }
  lines.push("}")
  lines.push("")
  lines.push("/**")
  lines.push(` * BARE ids on ${endpoint.label} whose wire surface is the Anthropic Messages`)
  lines.push(" * API — the source's `provider.npm === \"@ai-sdk/anthropic\"`. These are the")
  lines.push(" * ONLY ids reachable through the Anthropic-compatible gateway preset of the")
  lines.push(" * same name (claude-code / claude-sdk); the rest of the endpoint's lineup")
  lines.push(" * speaks OpenAI chat/completions or the OpenAI Responses API and has to go")
  lines.push(" * through the opencode adapter instead. Bare (not `<provider>/<id>`) because")
  lines.push(" * that is what an Anthropic client puts in `ANTHROPIC_MODEL` / on the wire.")
  lines.push(" */")
  lines.push(`export const ${endpoint.anthropicConst}: readonly string[] = [`)
  for (const id of [...anthropicIds].sort()) {
    lines.push(`  ${JSON.stringify(id)},`)
  }
  lines.push("]")
  lines.push("")
  return lines.join("\n")
}

// ── Snapshot projection ─────────────────────────────────────────────────

/** The committed snapshot's per-model shape — a strict subset of the source's
 *  own, so one schema parses both. */
interface ProjectedModel {
  id?: string
  name?: string
  family?: string
  release_date?: string
  provider?: { npm: string }
  cost?: {
    input?: number
    output?: number
    cache_read?: number
    cache_write?: number
  }
}

/** The committed snapshot's per-provider shape (see {@link ProjectedModel}). */
interface ProjectedProvider {
  id?: string
  name?: string
  api?: string
  doc?: string
  env?: readonly string[]
  npm?: string
  models: Record<string, ProjectedModel>
}

/**
 * Narrow the raw models.dev payload to one provider and to the fields this
 * generator models, with deterministic (sorted) model order and a fixed field
 * order. Shape-identical to the source, so {@link SnapshotSchema} parses this
 * projection and re-projecting it is a no-op — which is what makes `--check`
 * drift detection meaningful on the snapshot itself.
 */
function projectSnapshot(providerKey: string, provider: SourceProvider): string {
  const models: Record<string, ProjectedModel> = {}
  for (const bareId of Object.keys(provider.models ?? {}).sort()) {
    const model = provider.models?.[bareId]
    if (!model) continue
    // Object-literal spreads, not assignments: JSON.stringify emits keys in
    // insertion order, so a FIXED literal order is what makes the committed
    // snapshot byte-stable across runs.
    models[bareId] = {
      ...(model.id !== undefined ? { id: model.id } : {}),
      ...(model.name !== undefined ? { name: model.name } : {}),
      ...(model.family !== undefined ? { family: model.family } : {}),
      ...(model.release_date !== undefined ? { release_date: model.release_date } : {}),
      ...(model.provider?.npm !== undefined ? { provider: { npm: model.provider.npm } } : {}),
      ...(model.cost !== undefined
        ? {
            cost: {
              ...(model.cost.input !== undefined ? { input: model.cost.input } : {}),
              ...(model.cost.output !== undefined ? { output: model.cost.output } : {}),
              ...(model.cost.cache_read !== undefined
                ? { cache_read: model.cost.cache_read }
                : {}),
              ...(model.cost.cache_write !== undefined
                ? { cache_write: model.cost.cache_write }
                : {}),
            },
          }
        : {}),
    }
  }

  const projected: ProjectedProvider = {
    ...(provider.id !== undefined ? { id: provider.id } : {}),
    ...(provider.name !== undefined ? { name: provider.name } : {}),
    ...(provider.api !== undefined ? { api: provider.api } : {}),
    ...(provider.doc !== undefined ? { doc: provider.doc } : {}),
    ...(provider.env !== undefined ? { env: provider.env } : {}),
    ...(provider.npm !== undefined ? { npm: provider.npm } : {}),
    models,
  }

  return `${JSON.stringify({ [providerKey]: projected }, null, 2)}\n`
}

/** Repo-relative snapshot path for a source id — mirrors `runner.ts`'s
 *  `snapshotPath`, expressed repo-relative so the projection can ride along
 *  in {@link GeneratedFiles}. */
function snapshotRelPath(ledgerId: string): string {
  return `packages/catalog-sync/snapshots/${ledgerId}.json`
}

// ── Generator ───────────────────────────────────────────────────────────

/**
 * The bare ids served on the Anthropic Messages surface. models.dev
 * discriminates an endpoint's wire surfaces per model via `provider.npm`:
 * absent ⇒ OpenAI chat/completions, `@ai-sdk/anthropic` ⇒ Anthropic
 * Messages, `@ai-sdk/openai` ⇒ OpenAI Responses, `@ai-sdk/google` ⇒ Gemini.
 * Only the Anthropic set is emitted, because that is the one a caller has to
 * know: it is exactly what the gateway preset can serve.
 */
function anthropicSurfaceIds(models: Readonly<Record<string, SourceModel>>): string[] {
  return Object.entries(models)
    .filter(([, model]) => model.provider?.npm === "@ai-sdk/anthropic")
    .map(([bareId]) => bareId)
    .sort()
}

async function generateFor(
  endpoint: OpencodeEndpoint,
  source: { id: string; url: string },
  ctx: GeneratorContext
): Promise<GeneratedFiles> {
  const parsed = SnapshotSchema.parse(await ctx.fetchSource(source))
  const provider = parsed[endpoint.providerKey]
  if (!provider) {
    throw new Error(
      `${endpoint.generatorName}: models.dev payload carries no "${endpoint.providerKey}" provider ` +
        `(source ${source.url}). Refusing to emit an empty route table.`
    )
  }
  const models = provider.models ?? {}

  const entries: Record<string, LLMPricingEntry> = {}
  const releasedAt: Record<string, string> = {}
  for (const [bareId, model] of Object.entries(models)) {
    const inputPer1M = model.cost?.input
    const outputPer1M = model.cost?.output
    // An entry with no published price at all is skipped: a fabricated 0 would
    // read as "free" to the billing surface. An explicit 0 IS kept (the `-free`
    // variants) — see the header comment in the emitted file.
    if (inputPer1M === undefined || outputPer1M === undefined) continue
    if (!Number.isFinite(inputPer1M) || !Number.isFinite(outputPer1M)) continue

    const key = routeKey(endpoint.providerKey, bareId)
    const entry: LLMPricingEntry = {
      inputPer1M: round6(inputPer1M),
      outputPer1M: round6(outputPer1M),
      vendor: vendorForOpencodeModelId(bareId),
      provider: endpoint.providerKey,
    }
    const read = cacheMultiplier(model.cost?.cache_read, inputPer1M)
    if (read !== undefined) entry.cacheReadMultiplier = read
    const write = cacheMultiplier(model.cost?.cache_write, inputPer1M)
    if (write !== undefined) entry.cacheWriteMultiplier = write

    entries[key] = entry
    if (model.release_date !== undefined) releasedAt[key] = model.release_date
  }

  const ledger = computeAddedAtLedger(
    Object.keys(entries),
    readLedger(endpoint.ledgerId),
    releasedAt,
    todayIso()
  )
  for (const [key, entry] of Object.entries(entries)) entry.addedAt = ledger[key]

  return {
    [endpoint.outputPath]: serializeFile(endpoint, entries, anthropicSurfaceIds(models)),
    [ledgerRelPath(endpoint.ledgerId)]: serializeLedger(ledger),
    [snapshotRelPath(endpoint.ledgerId)]: projectSnapshot(endpoint.providerKey, provider),
  }
}

/** models.dev needs no credential, so `headers` is deliberately absent — the
 *  runner only reuses a committed snapshot instead of refreshing when a
 *  referenced env var is missing, and there is none to miss here. */
const goSources = [{ id: GO.ledgerId, url: MODELS_DEV_URL }]
const zenSources = [{ id: ZEN.ledgerId, url: MODELS_DEV_URL }]

export const llmOpencodeGoGenerator = defineGenerator({
  name: GO.generatorName,
  modality: "llm",
  sources: goSources,
  generate: ctx => generateFor(GO, goSources[0]!, ctx),
})

export const llmOpencodeZenGenerator = defineGenerator({
  name: ZEN.generatorName,
  modality: "llm",
  sources: zenSources,
  generate: ctx => generateFor(ZEN, zenSources[0]!, ctx),
})

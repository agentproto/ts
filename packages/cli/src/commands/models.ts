/**
 * `agentproto models [adapter]` — what models can I actually run, right now?
 *
 * Joins three sources:
 *   1. the installed adapters' advertised model lists (manifest `models`) —
 *      via the MERGED listing (native npm catalog + generic ACP entries, see
 *      `listAdaptersWithAcp`), so a generic-ACP harness like `mistral-vibe`
 *      lists its curated models too,
 *   2. the provider-key store + this process's env — so each model is marked
 *      runnable (✓) only when its provider has a key, and
 *   3. `@agentproto/model-catalog` for $/Mtok enrichment when the id matches.
 *
 * The point: `--model anthropic/claude-opus-4-8` fails at runtime with "no
 * ANTHROPIC_API_KEY" if you haven't set a key. This surfaces that up front —
 * pick a model whose provider you're actually configured for.
 */

import { parseArgs } from "node:util"
import { loadProviders, providerEnvVar } from "@agentproto/runtime/providers-store"
import { LLM_PRICING_CATALOG, effectivePricing, resolveContextWindow, formatTokens } from "@agentproto/model-catalog/llm"
import { listAdaptersWithAcp } from "../registry/resolve.js"
import { CATALOG } from "../registry/catalog.js"

const USAGE = `agentproto models — list runnable models per adapter

Usage:
  agentproto models [adapter] [--json]

  agentproto models                 # every installed agent adapter
  agentproto models mastra-agent    # one adapter, detailed
  agentproto models mistral-vibe    # generic-ACP harnesses work too
  agentproto models --json

Each model is marked ✓ (provider key available) or ✗ (no key — set one with
\`agentproto auth provider set <provider> <key>\`). Prices, when known, come
from @agentproto/model-catalog ($ per 1M in/out tokens); context window and
max output tokens come from the live-synced CONTEXT_WINDOWS table — shown as
\`ctx 1M / out 128k\` and \`contextWindow\`/\`maxOutput\` in --json when known.
`

interface PricingEntry {
  inputPer1M?: number
  outputPer1M?: number
  provider?: string
}

/** Infer the gating provider from a bare model-id family prefix, so
 *  `runnable` reflects adapter auth rather than pricing-catalog membership.
 *  Without this a brand-new id (e.g. `claude-opus-4-8` before it lands in the
 *  pricing catalog) resolves to `unknown` → runnable:false even though the
 *  ANTHROPIC_API_KEY that spawns it is present. Returns undefined for an
 *  unrecognized family so the caller can fall back to the catalog. */
function providerFromIdPrefix(bareId: string): string | undefined {
  if (/^claude[-/]/.test(bareId)) return "anthropic"
  if (/^(gpt[-/]|o[1-9](-|$)|chatgpt)/.test(bareId)) return "openai"
  if (/^gemini[-/]/.test(bareId)) return "google"
  if (/^grok[-/]/.test(bareId)) return "x-ai"
  if (/^(deepseek)[-/]/.test(bareId)) return "deepseek"
  return undefined
}

/** The provider that gates a model id's key. `anthropic/claude-…` → anthropic
 *  (the slash prefix is authoritative); otherwise prefer the pricing entry's
 *  provider, then fall back to the id-family prefix so `runnable` tracks
 *  adapter auth, not pricing presence. */
function providerOf(modelId: string, pricing: PricingEntry | undefined): string {
  const slash = modelId.indexOf("/")
  if (slash > 0) return modelId.slice(0, slash)
  return pricing?.provider ?? providerFromIdPrefix(modelId) ?? "unknown"
}

/** Best-effort lookup into the bare-id-keyed pricing catalog: try the full id,
 *  then the segment after the first slash, then after the last slash. */
function pricingOf(modelId: string): PricingEntry | undefined {
  const cat = LLM_PRICING_CATALOG as Record<string, Parameters<typeof effectivePricing>[0] & PricingEntry>
  const first = modelId.slice(modelId.indexOf("/") + 1)
  const last = modelId.slice(modelId.lastIndexOf("/") + 1)
  // effectivePricing: a lapsed dated promo (e.g. MAI Code 2 after 2027-05-17)
  // resolves to its standard price instead of the stale promo one.
  const hit = cat[modelId] ?? cat[first] ?? cat[last]
  return hit ? effectivePricing(hit) : undefined
}

/** Adapters whose models are reached through the adapter's OWN login (a
 *  Copilot subscription), not through per-provider API keys. For these,
 *  "runnable" is the adapter's readiness, not `hasKey(provider)`: a Copilot
 *  user needs no ANTHROPIC_API_KEY to run `claude-sonnet-5.5`, and
 *  `mai-code-2` has no provider key at all. */
const ADAPTER_OWNS_AUTH: ReadonlySet<string> = new Set(["copilot-cli"])

/** Why a row shows no price: never a silent blank. */
const NO_PRICE_REASON = "no price in the catalog (not in the vendor's sync nor in Copilot's price list)"

/** A provider has a key if it's in this env OR the stored providers file. */
async function loadKeyChecker(): Promise<(provider: string) => boolean> {
  const store = await loadProviders()
  return (provider: string): boolean => {
    if (provider === "unknown") return false
    if (process.env[providerEnvVar(provider)]) return true
    return Boolean(store.providers[provider]?.apiKey)
  }
}

/** Per installed adapter with a model list: how many of its models are
 *  runnable with the provider keys available here — the one-line version of
 *  `agentproto models` (used by `agentproto setup`). */
export async function modelsSummary(): Promise<{ slug: string; runnable: number; total: number }[]> {
  const [all, hasKey] = await Promise.all([listAdaptersWithAcp(CATALOG), loadKeyChecker()])
  return all
    .filter(a => a.models.length > 0 && a.status !== "supported")
    .map(a => ({
      slug: a.slug,
      total: a.models.length,
      runnable: a.models.filter(id => hasKey(providerOfOnAdapter(a, id, pricingOf(id)))).length,
    }))
}

/** The provider that gates a model id's key ON ONE ADAPTER: the adapter's own
 *  per-model provider declaration wins (the authoritative statement of who
 *  bills THIS adapter for THIS model — a generic-ACP harness stamps its
 *  spec-level provider onto each model, so mistral-vibe's hosted z-ai ids
 *  bill through `mistral`), then the pricing catalog / id-family inference.
 *  Without this, `mistral models` rows for a hosted-but-renamed id showed
 *  provider `unknown` ✗ even with MISTRAL_API_KEY present. */
function providerOfOnAdapter(
  adapter: { modelDetails?: Array<{ id: string; provider?: string }> },
  modelId: string,
  pricing: PricingEntry | undefined,
): string {
  for (const m of adapter.modelDetails ?? []) {
    if (m.id === modelId && typeof m.provider === "string") return m.provider
  }
  return providerOf(modelId, pricing)
}

export async function runModels(args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    strict: true,
    allowPositionals: true,
    options: { json: { type: "boolean" }, help: { type: "boolean", short: "h" } },
  })
  if (values.help) {
    process.stdout.write(USAGE)
    return 0
  }

  const wanted = positionals[0]
  // The MERGED listing (npm/native catalog + generic ACP — the same listing
  // `adapter_list` and the runtime's catalog join serve): a generic-ACP
  // harness with curated models (kimi-cli, mistral-vibe) is declared in the
  // ACP catalog, not the npm one, so the native-only listing showed NOTHING
  // for it (`agentproto models mistral-vibe` used to return empty — issue
  // 2026-11-21). Generic entries whose bin is absent stay visible with their
  // `supported` status, exactly as native catalog rows do.
  const all = await listAdaptersWithAcp(CATALOG)
  const adapters = all.filter(
    a => a.models.length > 0 && (!wanted || a.slug === wanted),
  )
  if (wanted && adapters.length === 0) {
    process.stderr.write(
      `agentproto models: no installed adapter '${wanted}' with a model list.\n` +
        `  try: agentproto models   (lists all)\n` +
        `       agentproto adapters  (lists every adapter, model-less ones included)\n`,
    )
    return 2
  }
  if (!wanted && adapters.length === 0) {
    // No adapter with a model list is installed. Emit a one-line hint
    // instead of empty output — a blank terminal is the worst UX on a
    // fresh machine because the user can't tell whether the verb worked.
    process.stdout.write(
      `no adapters installed — try: agentproto install claude-code\n`
    )
    return 0
  }

  const hasKey = await loadKeyChecker()

  if (values.json) {
    process.stdout.write(
      JSON.stringify(
        {
          adapters: adapters.map(a => ({
            adapter: a.slug,
            status: a.status,
            models: a.models.map(id => {
              const pricing = pricingOf(id)
              const provider = providerOfOnAdapter(a, id, pricing)
              const ctx = resolveContextWindow(id)
              return {
                id,
                provider,
                runnable: ADAPTER_OWNS_AUTH.has(a.slug) ? a.status === "ready" : hasKey(provider),
                inputPer1M: pricing?.inputPer1M ?? null,
                outputPer1M: pricing?.outputPer1M ?? null,
                ...(pricing?.inputPer1M == null ? { priceNote: NO_PRICE_REASON } : {}),
                contextWindow: formatTokens(ctx?.contextWindow),
                maxOutput: formatTokens(ctx?.maxOutput),
              }
            }),
          })),
        },
        null,
        2,
      ) + "\n",
    )
    return 0
  }

  const missing = new Set<string>()
  for (const a of adapters) {
    process.stdout.write(`\n${a.slug}  (${a.status})\n`)
    for (const id of a.models) {
      const pricing = pricingOf(id)
      const provider = providerOfOnAdapter(a, id, pricing)
      const ownsAuth = ADAPTER_OWNS_AUTH.has(a.slug)
      const ok = ownsAuth ? a.status === "ready" : hasKey(provider)
      if (!ok && !ownsAuth) missing.add(provider)
      const price =
        pricing?.inputPer1M != null
          ? `  $${pricing.inputPer1M}/$${pricing.outputPer1M ?? "?"} per 1M`
          : `  price n/a: ${NO_PRICE_REASON}`
      const ctx = resolveContextWindow(id)
      const ctxText =
        ctx?.contextWindow != null
          ? `  ctx ${formatTokens(ctx.contextWindow)}/${ctx.maxOutput != null ? `out ${formatTokens(ctx.maxOutput)}` : "out ?"}`
          : ""
      process.stdout.write(
        `  ${ok ? "✓" : "✗"} ${id}${" ".repeat(Math.max(1, 36 - id.length))}${provider}${price}${ctxText}\n`,
      )
    }
  }
  missing.delete("unknown")
  if (missing.size > 0) {
    process.stdout.write(
      `\n✗ = no provider key. Set one:\n` +
        [...missing]
          .map(p => `    agentproto auth provider set ${p} <api-key>`)
          .join("\n") +
        "\n",
    )
  }
  return 0
}

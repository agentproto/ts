/**
 * `agentproto models [adapter]` — what models can I actually run, right now?
 *
 * Joins three sources:
 *   1. the installed adapters' advertised model lists (manifest `models`),
 *   2. the provider-key store + this process's env — so each model is marked
 *      runnable (✓) only when its provider has a key, and
 *   3. `@agentproto/model-catalog` for $/Mtok enrichment when the id matches.
 *
 * The point: `--model anthropic/claude-opus-4-8` fails at runtime with "no
 * ANTHROPIC_API_KEY" if you haven't set a key. This surfaces that up front —
 * pick a model whose provider you're actually configured for.
 */

import { parseArgs } from "node:util"
import { listAdaptersWithCatalog } from "../registry/resolve.js"
import { CATALOG } from "../registry/catalog.js"
import { loadProviders, providerEnvVar } from "@agentproto/runtime/providers-store"
import { LLM_PRICING_CATALOG, resolveContextWindow, formatTokens } from "@agentproto/model-catalog/llm"

const USAGE = `agentproto models — list runnable models per adapter

Usage:
  agentproto models [adapter] [--json]

  agentproto models                 # every installed agent adapter
  agentproto models mastra-agent    # one adapter, detailed
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
  const cat = LLM_PRICING_CATALOG as Record<string, PricingEntry>
  if (cat[modelId]) return cat[modelId]
  const first = modelId.slice(modelId.indexOf("/") + 1)
  if (cat[first]) return cat[first]
  const last = modelId.slice(modelId.lastIndexOf("/") + 1)
  return cat[last]
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
  const all = await listAdaptersWithCatalog(CATALOG)
  const adapters = all.filter(
    a => a.models.length > 0 && (!wanted || a.slug === wanted),
  )
  if (wanted && adapters.length === 0) {
    process.stderr.write(
      `agentproto models: no installed adapter '${wanted}' with a model list.\n` +
        `  try: agentproto models   (lists all)\n`,
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

  // A provider has a key if it's in this env OR the stored providers file.
  const store = await loadProviders()
  const hasKey = (provider: string): boolean => {
    if (provider === "unknown") return false
    if (process.env[providerEnvVar(provider)]) return true
    return Boolean(store.providers[provider]?.apiKey)
  }

  if (values.json) {
    process.stdout.write(
      JSON.stringify(
        {
          adapters: adapters.map(a => ({
            adapter: a.slug,
            status: a.status,
            models: a.models.map(id => {
              const pricing = pricingOf(id)
              const provider = providerOf(id, pricing)
              const ctx = resolveContextWindow(id)
              return {
                id,
                provider,
                runnable: hasKey(provider),
                inputPer1M: pricing?.inputPer1M ?? null,
                outputPer1M: pricing?.outputPer1M ?? null,
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
      const provider = providerOf(id, pricing)
      const ok = hasKey(provider)
      if (!ok) missing.add(provider)
      const price =
        pricing?.inputPer1M != null
          ? `  $${pricing.inputPer1M}/$${pricing.outputPer1M ?? "?"} per 1M`
          : ""
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

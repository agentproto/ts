/**
 * LLM Pricing Catalog — per-token costs for all LLM models.
 *
 * Migrated from `packages/core/src/config/llm-pricing.ts` (commit `eeb1acdc`
 * era). The original location now re-exports from here so every existing
 * consumer (orchestrator dynamic imports, agent-analytics) keeps working.
 *
 * Prices in USD per 1M tokens (input and output separated).
 * Credit costs are what we charge users (includes margin).
 */

import type { CatalogProvider } from "../schema/base.js"

export interface LLMPricing {
  /** Provider cost: $ per 1M input tokens */
  inputPer1M: number
  /** Provider cost: $ per 1M output tokens */
  outputPer1M: number
  /**
   * Strategic per-model centicredit override for input. Bypasses the
   * default `inputPer1M × text-markup / CC_USD_RATE` formula. Use only
   * for explicit loss-leader / promo models — formula path is
   * cost-plus-margin by construction and self-heals when providers
   * change rates.
   *
   * Unit: **centicredits per 1M input tokens** (1 displayed credit =
   * 100 cc). Example: `overrideCreditInputPer1M: 1000` charges 10
   * displayed credits per 1M input tokens.
   */
  overrideCreditInputPer1M?: number
  /** Same as `overrideCreditInputPer1M`, for output tokens. Unit: cc/1M. */
  overrideCreditOutputPer1M?: number
  /**
   * Provider-side discount for cache-read tokens (Anthropic prompt
   * caching: ~10% of base input). Default 1.0 — no cache discount —
   * for providers without prompt caching. Applies to BOTH the
   * provider-cost calculation AND the derived credit cost so the
   * margin holds for cached vs uncached tokens.
   */
  cacheReadMultiplier?: number
  /**
   * Provider-side premium for cache-creation tokens (Anthropic prompt
   * caching: ~125% of base input — slightly more than uncached, but
   * the savings come from subsequent reads). Default 1.0. Applies to
   * BOTH sides like `cacheReadMultiplier`.
   */
  cacheWriteMultiplier?: number
  /**
   * Router / SDK used to call the model. Same model can be reachable via
   * multiple providers — `claude-sonnet-4-5` is `provider: "anthropic"`
   * when called through the Anthropic SDK and `provider: "openrouter"`
   * when routed through OpenRouter. Distinct from `vendor`: this is HOW
   * we reach the model, not WHO made it.
   *   - bare ids (`claude-sonnet-4-5`, `gpt-4o`, `gemini-2.5-flash`)
   *     → `"anthropic" | "openai" | "google"` (direct providers)
   *   - slash ids (`anthropic/claude-sonnet-4-5`, `qwen/qwen3-coder`)
   *     → `"openrouter"` (always — the slash is the OpenRouter route
   *     convention and the OpenRouter SDK is what runs them)
   *
   * The runtime can still pass an explicit `connectorUsed` to
   * `emitUsageEvent` — that wins over this default and covers the
   * edge case where a guild has multiple connectors and the
   * dispatcher routed to a non-default one.
   */
  provider?: CatalogProvider
  /**
   * Who authored / built the model. Permanent attribute, independent of
   * the router: `claude-sonnet-4-5` is always `vendor: "anthropic"`
   * regardless of whether `provider` is `"anthropic"` (direct) or
   * `"openrouter"` (proxied). Used for display labels, BYOK gating, and
   * analytics grouping. Examples: `anthropic`, `openai`, `google`,
   * `moonshot`, `mistralai`, `minimax`, `meta`, `qwen`, `deepseek`.
   */
  vendor?: string
  /**
   * ISO date (`YYYY-MM-DD`) this id was first seen by a catalog-sync run.
   * Generator-owned (currently emitted by `llm:openrouter` / `llm:requesty`;
   * hand-maintained catalog rows below leave it unset) — backfilled from the
   * provider's own creation timestamp when the source has one, else the
   * sync run's date, and NEVER mutated once stamped. See
   * `packages/catalog-sync/src/added-at.ts` and
   * `packages/catalog-sync/README.md` for the full convention.
   */
  addedAt?: string
}

import { OPENROUTER_ROUTES } from "./openrouter-routes.generated.js"
import { pricingRegistry, CC_USD_RATE } from "../pricing/index.js"
import { CONTEXT_WINDOWS, type ContextWindowEntry } from "./context-windows.generated.js"
import { MISTRAL_GENERATED_PRICING } from "./mistral-pricing.generated.js"
import { MOONSHOT_GENERATED_PRICING } from "./moonshot-pricing.generated.js"
import { ANTHROPIC_GENERATED_PRICING } from "./anthropic-pricing.generated.js"
import { GOOGLE_GENERATED_PRICING } from "./google-pricing.generated.js"
import { OPENAI_GENERATED_PRICING } from "./openai-pricing.generated.js"
import { MINIMAX_GENERATED_PRICING } from "./minimax-pricing.generated.js"
import { XAI_GENERATED_PRICING } from "./xai-pricing.generated.js"

/**
 * Explicit, named, reasoned manual pricing — the ONLY sanctioned form of
 * hand-written pricing left in this catalog. An id lands here for exactly
 * one of two reasons, stated per-entry in `reason`:
 *   - no generator covers this id at all (a structural gap — a "-latest"
 *     alias spelling, a retired preview, a build-suffix/alias mismatch), or
 *   - the value is a known-unverified placeholder that predates any sync.
 *
 * An id a generator DOES cover is priced by that generator directly and
 * NEVER duplicated here, regardless of whether the (now deleted) hand-typed
 * row used to disagree with the generated value — generated wins
 * unconditionally on a divergence; see the PR body's divergence table for
 * every case that applied to, and the exact two values each side had.
 */
export const PRICING_OVERRIDES: Record<string, LLMPricing & { reason: string }> = {
  // claude-opus-4-5 / claude-haiku-4-5 / claude-sonnet-4-5 (bare) and
  // grok-4.20 / grok-4.20-reasoning / grok-4.20-multi-agent used to live
  // here as hand-typed numbers, justified by "no generator produces this
  // exact spelling" — true, but that only justifies the id's EXISTENCE, not
  // hand-typing its PRICE when a same-model sibling under a different id is
  // already generated (Anthropic's dated form, xAI's own declared alias).
  // Fixed at the generator, not papered over here:
  //   - sync-anthropic.mjs now mechanically derives every bare "aged-out"
  //     id from its dated sibling (strip the -YYYYMMDD suffix), same price.
  //   - sync-xai.mjs now expands every model's own `aliases` array from
  //     xAI's live payload into additional priced entries.
  // Both bare-id sets are gone from this map for good — see the PR body's
  // divergence table for what the old hand-typed numbers here were wrong
  // by (these were on ids adapters/auth-profiles actually spawn).

  "kimi-k2-0905-preview": {
    reason:
      "Not present in Moonshot's current live model list (api.moonshot.ai/v1/models returned 4 models total on the sync run that produced moonshot-pricing.generated.ts) -- likely retired or renamed since this row was hand-added.",
    inputPer1M: 0.6, outputPer1M: 2.5, cacheReadMultiplier: 0.25, vendor: "moonshot", provider: "moonshot",
  },

  "kimi-k2-thinking": {
    reason:
      "Same as kimi-k2-0905-preview -- absent from Moonshot's current live model list.",
    inputPer1M: 0.6, outputPer1M: 2.5, cacheReadMultiplier: 0.25, vendor: "moonshot", provider: "moonshot",
  },

  "kimi-k2-thinking-turbo": {
    reason:
      "Same as kimi-k2-0905-preview -- absent from Moonshot's current live model list.",
    inputPer1M: 1.15, outputPer1M: 8.0, cacheReadMultiplier: 0.13, vendor: "moonshot", provider: "moonshot",
  },

  "kimi-k2-turbo-preview": {
    reason:
      "Same as kimi-k2-0905-preview -- absent from Moonshot's current live model list.",
    inputPer1M: 1.15, outputPer1M: 8.0, cacheReadMultiplier: 0.13, vendor: "moonshot", provider: "moonshot",
  },

  "kimi-k2.5": {
    reason:
      "Same as kimi-k2-0905-preview -- absent from Moonshot's current live model list.",
    inputPer1M: 0.6, outputPer1M: 3.0, cacheReadMultiplier: 0.17, vendor: "moonshot", provider: "moonshot",
  },

  // mistral-large-latest / mistral-small-latest / codestral-latest /
  // ministral-8b-latest: "no generator produces this exact -latest
  // spelling" is true and justifies the id existing here, but it does NOT
  // justify a hand-typed NUMBER when a same-family dated sibling is already
  // generated (mistral-large-2512, mistral-small-2603, codestral-2508,
  // ministral-8b-2512 respectively) — that was the same mistake as the
  // Anthropic/xAI bare-id overrides above, just not mechanically fixable at
  // the generator (Mistral's dated suffixes, e.g. -2512, don't strip back
  // to "-latest" the way Anthropic's -YYYYMMDD strips to a bare id). Spread
  // the generated sibling's pricing directly instead of retyping it, so a
  // re-sync that changes the dated price changes this too, automatically.
  "mistral-large-latest": {
    reason: "\"-latest\" alias spelling has no generated counterpart of its own; derives from the dated sibling mistral-large-2512 (MISTRAL_GENERATED_PRICING) rather than a hand-typed number.",
    ...MISTRAL_GENERATED_PRICING["mistral-large-2512"],
  },

  "mistral-small-latest": {
    reason: "\"-latest\" alias spelling has no generated counterpart of its own; derives from the dated sibling mistral-small-2603 (MISTRAL_GENERATED_PRICING) rather than a hand-typed number. The old hand-typed value here (0.06/0.18, cache 0.5) diverged from this — see the PR body's divergence table.",
    ...MISTRAL_GENERATED_PRICING["mistral-small-2603"],
  },

  "codestral-latest": {
    reason: "\"-latest\" alias spelling has no generated counterpart of its own; derives from the dated sibling codestral-2508 (MISTRAL_GENERATED_PRICING) rather than a hand-typed number. The old hand-typed value here (0.5/1.5, a copy-pasted placeholder) diverged from this — see the PR body's divergence table.",
    ...MISTRAL_GENERATED_PRICING["codestral-2508"],
  },

  "ministral-8b-latest": {
    reason: "\"-latest\" alias spelling has no generated counterpart of its own; derives from the dated sibling ministral-8b-2512 (MISTRAL_GENERATED_PRICING) rather than a hand-typed number. The old hand-typed value here (0.06/0.18, a copy-pasted placeholder) diverged from this — see the PR body's divergence table.",
    ...MISTRAL_GENERATED_PRICING["ministral-8b-2512"],
  },

  "mistral-medium-latest": {
    reason:
      "PLACEHOLDER, explicitly marked `// TODO verify pricing` in the row this replaces -- copy-pasted 0.5/1.5 template value, never real. Unlike the four rows above, this one is NOT auto-derived from a generated sibling: MISTRAL_GENERATED_PRICING has THREE medium candidates (mistral-medium-3, mistral-medium-3-5, mistral-medium-3.5) and which one \"-latest\" currently means is an editorial call this sync can't safely make -- picking wrong would silently misprice, which is worse than an honestly-labeled unverified placeholder. Needs a human to confirm which dated id is current, then wire it the same way as mistral-large-latest above.",
    inputPer1M: 0.5, outputPer1M: 1.5, vendor: "mistral", provider: "mistral",
  },

  "devstral-latest": {
    reason:
      "PLACEHOLDER, explicitly marked `// TODO verify pricing` -- copy-pasted 0.5/1.5 template value, never real. No generated counterpart at all (Mistral's chat-model sync doesn't currently return a devstral id).",
    inputPer1M: 0.5, outputPer1M: 1.5, vendor: "mistral", provider: "mistral",
  },

  "magistral-small-latest": {
    reason:
      "PLACEHOLDER, explicitly marked `// TODO verify pricing` -- copy-pasted 0.06/0.18 template value, never real. No generated counterpart at all.",
    inputPer1M: 0.06, outputPer1M: 0.18, vendor: "mistral", provider: "mistral",
  },

  "devstral-medium-latest": {
    reason:
      "PLACEHOLDER, explicitly marked `// TODO verify pricing` -- copy-pasted 0.5/1.5 template value, never real. No generated counterpart at all.",
    inputPer1M: 0.5, outputPer1M: 1.5, vendor: "mistral", provider: "mistral",
  },

  "gpt-5-codex": {
    reason:
      "No generated counterpart -- not present in OpenRouter's openai/* listing under this exact id (OpenAI has no native pricing endpoint at all, see packages/catalog-sync/src/sources/openai.ts, so OpenRouter is the only automated source and it doesn't carry this specific id).",
    inputPer1M: 1.25, outputPer1M: 10.0, cacheReadMultiplier: 0.1, vendor: "openai", provider: "openai",
  },

  "o1-mini": {
    reason:
      "No generated counterpart -- not present in OpenRouter's openai/* listing under this exact id.",
    inputPer1M: 0.55, outputPer1M: 2.2, vendor: "openai", provider: "openai",
  },

  "o3-deep-research": {
    reason:
      "No generated counterpart -- not present in OpenRouter's openai/* listing under this exact id.",
    inputPer1M: 10.0, outputPer1M: 40.0, cacheReadMultiplier: 0.25, vendor: "openai", provider: "openai",
  },

  "o4-mini-deep-research": {
    reason:
      "No generated counterpart -- not present in OpenRouter's openai/* listing under this exact id.",
    inputPer1M: 2.0, outputPer1M: 8.0, cacheReadMultiplier: 0.25, vendor: "openai", provider: "openai",
  },
}

/** `PRICING_OVERRIDES` stripped of its `reason` field — what actually gets
 *  spread into `LLM_PRICING_CATALOG`; `reason` is documentation, not a
 *  pricing field. */
const PRICING_OVERRIDES_PRICING: Record<string, LLMPricing> = Object.fromEntries(
  Object.entries(PRICING_OVERRIDES).map(([id, { reason: _reason, ...pricing }]) => [id, pricing])
)

export const LLM_PRICING_CATALOG = {
  // Every provider below is fully generated from that provider's own live
  // sync (`scripts/catalog-sync/sync-*.mjs`) — existence AND price both come
  // from the provider's native id space wherever the provider exposes one
  // (Anthropic, xAI, MiniMax, Moonshot, Mistral, Google-via-remap); OpenRouter
  // supplies PRICE only for those, never ids, except for OpenAI, the one
  // provider with no native id/pricing source of its own at all, where
  // OpenRouter is the sole source for both. On any id a generator covers,
  // the generated value wins UNCONDITIONALLY — no hand-typed row duplicates
  // an id a generator already prices, even where they used to disagree; see
  // the PR body's divergence table. `PRICING_OVERRIDES` above is the only
  // surviving hand-written pricing, spread last, one reasoned entry per id.
  ...MISTRAL_GENERATED_PRICING,
  ...MOONSHOT_GENERATED_PRICING,
  ...ANTHROPIC_GENERATED_PRICING,
  ...GOOGLE_GENERATED_PRICING,
  ...OPENAI_GENERATED_PRICING,
  ...MINIMAX_GENERATED_PRICING,
  ...XAI_GENERATED_PRICING,
  ...PRICING_OVERRIDES_PRICING,

  // ── OpenRouter routes — generated by `scripts/catalog-sync` from
  // https://openrouter.ai/api/v1/models. Re-run
  // `pnpm --filter @agentproto/catalog-sync sync:openrouter`
  // to refresh.
  ...OPENROUTER_ROUTES,
} satisfies Record<string, LLMPricing>

/**
 * Every canonical catalog model id. Existence is NOT the same question as
 * "does this id have a price" — `LLM_PRICING_CATALOG`'s keys alone used to
 * answer both, which meant a real, live, provider-published model with no
 * pricing row yet (the Anthropic `claude-opus-4-6` incident: synced by
 * `catalog-sync`, present in `CONTEXT_WINDOWS`, absent here) simply ceased
 * to exist anywhere downstream — invisible in `agentproto models`, unlisted
 * in every adapter's native allow-list, silently resolved to a stale alias.
 * `LlmModelId` now unions the pricing keys with `CONTEXT_WINDOWS` (each
 * provider's own synced `/v1/models` id list — see
 * `packages/catalog-sync/src/generators/llm-context-windows.ts` — carries
 * ids independent of whether a price has synced yet) and `OPENROUTER_ROUTES`
 * (thousands of ids, self-updating). A model can be a member of this type
 * with `resolvePricing` returning `undefined` for it — callers MUST treat
 * that as "price not yet known," never as "doesn't exist" (see
 * `ResolvedModel`'s `pricing?` in `registry/index.ts`, and `isKnownLlmId`
 * below for an existence-only check). Downstream curation/config should
 * still constrain ids to this type so a typo is a build error.
 */
export type LlmModelId =
  | keyof typeof LLM_PRICING_CATALOG
  | keyof typeof CONTEXT_WINDOWS
  | keyof typeof OPENROUTER_ROUTES

/**
 * True iff `modelId` is a real, known catalog id — regardless of whether it
 * has a price yet. Use this (not `resolvePricing(id) !== undefined`) to
 * answer "does this model exist"; use `resolvePricing`/`resolvePricingExact`
 * to answer "what does it cost" — the two questions are independent by
 * design, see `LlmModelId`'s doc comment.
 */
export function isKnownLlmId(modelId: string): boolean {
  return (
    modelId in LLM_PRICING_CATALOG ||
    modelId in CONTEXT_WINDOWS ||
    modelId in OPENROUTER_ROUTES
  )
}

/**
 * Every known LLM id that has NO pricing row (`CONTEXT_WINDOWS` ∪
 * `OPENROUTER_ROUTES`, minus whatever `LLM_PRICING_CATALOG` already prices)
 * — the enumeration `listModels`'s `llm` branch needs to surface a
 * known-but-unpriced model instead of silently dropping it. Each entry
 * carries its provider when derivable (see `getModelProvider`).
 */
export function listUnpricedKnownLlmIds(): Array<{
  id: string
  provider: CatalogProvider | undefined
}> {
  const ids = new Set<string>([
    ...Object.keys(CONTEXT_WINDOWS),
    ...Object.keys(OPENROUTER_ROUTES),
  ])
  const result: Array<{ id: string; provider: CatalogProvider | undefined }> = []
  for (const id of ids) {
    if (id in LLM_PRICING_CATALOG) continue
    result.push({ id, provider: getModelProvider(id) })
  }
  return result
}

// ── Aliases (map model IDs to catalog keys) ─────────────────────────────

export const MODEL_ALIASES = {
  // Anthropic — alias targets must be real Anthropic model ids since
  // `resolveAlias` feeds the result straight to the SDK.
  //
  // `claude-opus-4-6` / `claude-sonnet-4-6` used to alias here to 4.5 —
  // the silent-downgrade bug this PR fixes (agentproto catalog-sync). Both
  // are now real, directly-priced `LlmModelId`s via
  // `ANTHROPIC_GENERATED_PRICING` above; an alias pointing them at 4.5
  // would just re-introduce the same silent downgrade, so it's removed,
  // not kept.
  "claude-4-opus": "claude-opus-4-5",
  "claude-4-sonnet": "claude-sonnet-4-5",
  "claude-3-5-haiku": "claude-haiku-4-5",
  "claude-haiku-4-5-20251001": "claude-haiku-4-5",
  // Back-compat: configs persisted under the old (invalid) catalog keys
  // route to the renamed canonical keys instead of 404'ing at Anthropic.
  "claude-opus-4": "claude-opus-4-5",
  "claude-sonnet-4": "claude-sonnet-4-5",
  "claude-haiku-3.5": "claude-haiku-4-5",
  // Google — slash-prefixed forms collapse to the direct catalog keys.
  // Bare `gemini-3.1-pro-preview` / `gemini-3-flash-preview` /
  // `gemini-2.5-flash-lite` / `gemini-3.1-flash-lite` are now real catalog
  // entries with their own verified pricing (direct match wins over alias).
  "gemini-3.1-flash-lite-preview": "gemini-3.1-flash-lite",
  "google/gemini-3.1-pro-preview": "gemini-3.1-pro-preview",
  "google/gemini-3.5-flash": "gemini-3.5-flash",
  "google/gemini-3-flash-preview": "gemini-3-flash-preview",
  "google/gemini-3.1-flash-lite": "gemini-3.1-flash-lite",
  "google/gemini-2.5-flash": "gemini-2.5-flash",
  "google/gemini-2.5-flash-lite": "gemini-2.5-flash-lite",
  "google/gemini-2.5-pro": "gemini-2.5-pro",
  // OpenAI
  "openai/gpt-4.1": "gpt-4.1",
  "openai/gpt-4.1-mini": "gpt-4.1-mini",
  "openai/gpt-4.1-nano": "gpt-4.1-nano",
  "openai/gpt-5": "gpt-5",
  "openai/gpt-5.1": "gpt-5.1",
  "openai/gpt-5.2": "gpt-5.2",
  "openai/gpt-5.4": "gpt-5.4",
  "openai/gpt-5.4-mini": "gpt-5.4-mini",
  "openai/gpt-5.4-nano": "gpt-5.4-nano",
  "openai/gpt-5.5": "gpt-5.5",
  "openai/o3": "o3",
  "openai/o4-mini": "o4-mini",
  "openai/o3-mini": "o3-mini",
  "openai/o1": "o1",
  "openai/o1-mini": "o1-mini",
  // MiniMax — lowercase / OpenRouter forms collapse to direct.
  "minimax-m2": "MiniMax-M2",
  "minimax-m2.1": "MiniMax-M2.1",
  "minimax-m2.5": "MiniMax-M2.5",
  "minimax-m2.7": "MiniMax-M2.7",
  // Moonshot — friendly version aliases.
  "kimi-k2": "kimi-k2.5",
  "moonshotai/kimi-k2.5": "kimi-k2.5",
  "moonshotai/kimi-k2.6": "kimi-k2.6",
  "moonshotai/kimi-k2.7-code": "kimi-k2.7-code",
  "moonshotai/kimi-k3": "kimi-k3",
  // Mistral
  "mistralai/mistral-large-latest": "mistral-large-latest",
  "mistralai/mistral-small-latest": "mistral-small-latest",
  "mistralai/mistral-medium-latest": "mistral-medium-latest",
  "mistralai/mistral-medium-3-5": "mistral-medium-3-5",
  "mistralai/codestral-latest": "codestral-latest",
  "mistralai/ministral-8b-latest": "ministral-8b-latest",
  "mistralai/devstral-latest": "devstral-latest",
  "mistralai/magistral-small-latest": "magistral-small-latest",
  "mistralai/devstral-medium-latest": "devstral-medium-latest",
  // xAI — alias grok-latest to grok-4.3 (current default).
  "grok-latest": "grok-4.3",
} satisfies Record<string, string>

/** Every alias id that resolves to a canonical model — the alias keys. */
export type LlmModelAlias = keyof typeof MODEL_ALIASES

/** Any model id the catalog recognises — canonical key or alias. */
export type KnownLlmId = LlmModelId | LlmModelAlias

// Typed wide views for dynamic (arbitrary-string) lookups. `satisfies`
// drops the string index signature on the consts above, so the
// resolution functions — which take untrusted `modelId: string` — index
// through these instead of the literal-keyed originals.
const PRICING_BY_ID: Record<string, LLMPricing> = LLM_PRICING_CATALOG
const ALIAS_BY_ID: Record<string, string> = MODEL_ALIASES

/**
 * Resolves a model id to its pricing entry. Tries direct match → alias →
 * partial-prefix match. Used both for cost computation and BYOK shadow
 * accounting; semantics are load-bearing for migration.
 */
export function resolvePricing(modelId: string): LLMPricing | undefined {
  // Direct match
  if (PRICING_BY_ID[modelId]) return PRICING_BY_ID[modelId]
  // Alias
  const alias = ALIAS_BY_ID[modelId]
  if (alias && PRICING_BY_ID[alias]) return PRICING_BY_ID[alias]
  // Partial match (e.g. "claude-sonnet-4-6-20260301" → "claude-sonnet-4")
  for (const key of Object.keys(PRICING_BY_ID)) {
    if (modelId.includes(key)) return PRICING_BY_ID[key]
  }
  return undefined
}

/**
 * Like {@link resolvePricing} but WITHOUT the substring/partial-prefix
 * fallback — an id resolves ONLY on an exact catalog key or an exact alias.
 * The substring scan in `resolvePricing` (intended for dated snapshots like
 * `claude-sonnet-4-6-20260301` → `claude-sonnet-4`) also over-fires for
 * unrelated cross-product siblings (`gemini-2.5-flash-image` substring-hits
 * the `gemini-2.5-flash` row), so any caller that must PROVE a verbatim
 * first-party identity — e.g. the direct-vendor route restore in
 * `serviceableModelRoutes` — needs this exact form instead. Semantics of
 * `resolvePricing`/`resolveAlias` are intentionally left unchanged for their
 * existing callers.
 */
export function resolvePricingExact(modelId: string): LLMPricing | undefined {
  // Direct match
  if (PRICING_BY_ID[modelId]) return PRICING_BY_ID[modelId]
  // Alias (exact key only — no substring fallback)
  const alias = ALIAS_BY_ID[modelId]
  if (alias && PRICING_BY_ID[alias]) return PRICING_BY_ID[alias]
  return undefined
}

/**
 * Resolves a model id to its canonical catalog key (or the original id if no
 * match). Public surface for consumers that need the canonical id without
 * the pricing payload.
 */
export function resolveAlias(modelId: string): string {
  if (PRICING_BY_ID[modelId]) return modelId
  const alias = ALIAS_BY_ID[modelId]
  if (alias && PRICING_BY_ID[alias]) return alias
  for (const key of Object.keys(PRICING_BY_ID)) {
    if (modelId.includes(key)) return key
  }
  return modelId
}

/**
 * Resolves a model id to its live context window (max input tokens) and max
 * output tokens, sourced from `CONTEXT_WINDOWS`
 * (`packages/catalog-sync/src/generators/llm-context-windows.ts` — re-synced
 * from each provider's live `/v1/models` endpoint; never hand-maintain these
 * numbers). Covers Anthropic, Groq, xAI, and Moonshot — the providers that
 * publish this data live. Handles bare aliases the provider's own API doesn't
 * use ("claude-haiku-4-5" vs. the dated live id "claude-haiku-4-5-20251001")
 * via prefix match, then falls back through the pricing alias table for
 * older aliases. Returns undefined for ids no synced provider carries.
 */
export function resolveContextWindow(modelId: string): ContextWindowEntry | undefined {
  if (CONTEXT_WINDOWS[modelId]) return CONTEXT_WINDOWS[modelId]
  const datedMatch = Object.keys(CONTEXT_WINDOWS)
    .filter(key => key.startsWith(`${modelId}-2`))
    .sort((a, b) => a.length - b.length)[0]
  if (datedMatch) return CONTEXT_WINDOWS[datedMatch]
  const alias = ALIAS_BY_ID[modelId]
  if (alias && CONTEXT_WINDOWS[alias]) return CONTEXT_WINDOWS[alias]
  return undefined
}

/**
 * Every live model id `CONTEXT_WINDOWS` carries for one provider — sourced
 * straight from that provider's own `/v1/models` sync (`llm-context-windows.ts`
 * generator), independent of whether the id has landed a pricing row yet.
 *
 * The one legitimate consumer of this today: an adapter's `models.allowed`
 * curation for its native (non-gateway) provider surface. Deriving that list
 * from here instead of a hand-typed array means a newly-published id (e.g.
 * Anthropic shipping `claude-opus-4-9`) becomes offerable the moment the next
 * catalog-sync run picks it up — no code change, no PR. An adapter that wants
 * to hide a specific id anyway (deprecated, not yet vetted) does so with its
 * OWN small denylist filtering this list's output, never by omitting the id
 * from a hand-typed allowlist that silently also hides every future id.
 */
export function listNativeModelIds(provider: ContextWindowEntry["provider"]): string[] {
  return Object.entries(CONTEXT_WINDOWS)
    .filter(([, entry]) => entry.provider === provider)
    .map(([id]) => id)
    .sort()
}

/**
 * Resolve a model id to its DEFAULT provider — the single source of truth for
 * "which SDK reaches this model when no per-model override is set". Reads the
 * resolved catalog entry's `provider` field (direct id → alias → partial
 * prefix, same resolution as `resolvePricing`). Returns undefined for unknown
 * ids so callers can fall back to their own heuristic.
 *
 * This is the abstraction that decouples the provider from the model-id STRING:
 * instead of inferring "claude-* → anthropic" at each call site, the provider
 * is an explicit catalog attribute. A model reachable through more than one
 * provider (e.g. Claude via the direct Anthropic SDK vs. OpenRouter) is held as
 * distinct catalog entries — the bare id (`claude-haiku-4-5`, provider
 * `anthropic`) and the slash route (`anthropic/claude-haiku-4.5`, provider
 * `openrouter`) — each carrying its own `provider`.
 */
export function getModelProvider(modelId: string): CatalogProvider | undefined {
  const pricedProvider = resolvePricing(modelId)?.provider
  if (pricedProvider) return pricedProvider
  // Fallback for a known-but-not-yet-priced id (see `LlmModelId`'s doc
  // comment) — CONTEXT_WINDOWS carries `provider` independent of pricing.
  // "groq" is a CONTEXT_WINDOWS provider but not a billing/auth
  // CatalogProvider (Groq never got a pricing generator — see the catalog
  // sync survey in the PR this comment shipped with), so it's excluded
  // rather than mis-cast.
  const cwProvider = resolveContextWindow(modelId)?.provider
  return cwProvider && cwProvider !== "groq" ? cwProvider : undefined
}

/**
 * The unified registry view of a model: canonical id, default provider, vendor,
 * and pricing — everything the routing + billing layers need from ONE lookup.
 * Returns undefined for unknown ids.
 */
export interface ModelRoute {
  /** Canonical catalog key (post-alias). */
  canonicalId: string
  /** Default provider — the SDK used when no per-model override is set. */
  provider?: CatalogProvider
  /** Model author/vendor (permanent; independent of the routing provider). */
  vendor?: string
  /** Billing pricing entry. */
  pricing: LLMPricing
}

export function resolveModelRoute(modelId: string): ModelRoute | undefined {
  const pricing = resolvePricing(modelId)
  if (!pricing) return undefined
  return {
    canonicalId: resolveAlias(modelId),
    provider: pricing.provider,
    vendor: pricing.vendor,
    pricing,
  }
}

/**
 * Default fallback: roughly gemini-flash pricing (cheapest). Unknown
 * model ids resolve to this — the formula path then computes credit
 * cost from `inputPer1M`/`outputPer1M`, so unknown models always price
 * at default markup × cheap-model rates, never at zero.
 */
export const DEFAULT_PRICING: LLMPricing = {
  inputPer1M: 0.15,
  outputPer1M: 0.6,
}

// ── Calculator ──────────────────────────────────────────────────────────

export interface LLMCreditCostResult {
  /**
   * Total **centicredits** to charge — what `useAccountCredits` debits
   * directly (ledger column is cc). Reflects any per-model override or
   * per-app markup; never below `MIN_CREDITS_PER_TURN_CC`.
   *
   * Unit: cc (1 displayed credit = 100 cc). Format for display with
   * `displayCredits(cc) → cr`.
   */
  credits: number
  /**
   * What the *pure formula* would have charged (provider cost ×
   * text-markup), independent of per-model overrides. Surfaced so
   * `usage_events.calculated_credits` can record the formula-derived
   * value next to the override-applied debit — easy reconciliation
   * against Langfuse traces. Unit: cc.
   */
  calculatedCredits: number
  /** Breakdown of `credits` (each in cc). */
  inputCredits: number
  outputCredits: number
  cacheReadCredits: number
  cacheWriteCredits: number
  /** Production cost in USD (true provider cost, with cache multipliers applied). */
  productionCost: number
  /** Model pricing used */
  pricing: LLMPricing
  /** Whether fallback pricing was used */
  isFallback: boolean
  /** Markup actually applied. Same as `pricingRegistry.getMarkup("text", appId)` when no override. */
  markup: number
  /** True when a per-model `overrideCredit*Per1M` field bypassed the formula. */
  hasOverride: boolean
}

export interface LLMUsageBreakdown {
  /**
   * Input tokens that were NOT served from cache. With Anthropic prompt
   * caching, providers often report `inputTokens` already EXCLUDING
   * cached portions — pass the same number you'd pass to the legacy
   * 3-arg signature; cache fields are ADDED on top.
   */
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens?: number
  cacheCreationInputTokens?: number
}

export interface CalculateLLMCreditCostOptions {
  /**
   * App invoking the LLM. Routes per-app markup overrides registered
   * via `pricingRegistry.registerApp(appId, ...)`. When omitted, core
   * defaults apply.
   */
  appId?: string
  /**
   * Direct markup override (escape hatch for tests / one-off
   * reconciliation). When set, bypasses `pricingRegistry` for both
   * formula and `calculatedCredits` math. Takes precedence over
   * `appId`.
   */
  markupOverride?: number
}

/**
 * Env-time markup escape hatch. Honored only when no `appId` or
 * `markupOverride` is provided — i.e. the legacy global tune still
 * works while we migrate call sites onto the registry.
 *
 * Going forward, prefer `pricingRegistry.registerApp(appId, { markup:
 * { text: 2.0 } })` at boot — env-coupled markup makes tests flaky
 * and hides per-app drift.
 */
const ENV_MARKUP_OVERRIDE = process.env.LLM_PRICING_MARKUP
  ? Number(process.env.LLM_PRICING_MARKUP)
  : undefined
/**
 * Minimum centicredits billed per LLM turn. 1 cc = 0.01 displayed
 * credit ≈ $0.0001. Picked over 1 displayed credit (the old floor) so
 * we don't over-charge tiny calls just because input + output each
 * round up.
 */
const MIN_CREDITS_PER_TURN_CC = 1

export function calculateLLMCreditCost(
  modelId: string,
  inputTokens: number,
  outputTokens: number
): LLMCreditCostResult
export function calculateLLMCreditCost(
  modelId: string,
  usage: LLMUsageBreakdown,
  opts?: CalculateLLMCreditCostOptions
): LLMCreditCostResult
export function calculateLLMCreditCost(
  modelId: string,
  inputOrUsage: number | LLMUsageBreakdown,
  outputTokensOrOpts?: number | CalculateLLMCreditCostOptions
): LLMCreditCostResult {
  // Disambiguate the 2-arg vs 3-arg / opts overload.
  const usage: LLMUsageBreakdown =
    typeof inputOrUsage === "number"
      ? {
          inputTokens: inputOrUsage,
          outputTokens:
            typeof outputTokensOrOpts === "number" ? outputTokensOrOpts : 0,
        }
      : inputOrUsage
  const opts: CalculateLLMCreditCostOptions =
    typeof outputTokensOrOpts === "object" && outputTokensOrOpts !== null
      ? outputTokensOrOpts
      : {}

  const resolved = resolvePricing(modelId)
  const pricing = resolved ?? DEFAULT_PRICING
  const isFallback = !resolved
  if (isFallback) {
    // `isFallback` is returned on `LLMCreditCostResult`/`CostResult` but
    // historically had no reader anywhere downstream — a model billed at
    // DEFAULT_PRICING's cheap-model rate instead of its real (possibly much
    // higher) provider cost had no observable signal anywhere except this
    // flag nobody checked. Surfacing it here (not changing the amount
    // charged — DEFAULT_PRICING's cost-plus-margin-at-cheap-rate behavior
    // is unchanged and intentional, see DEFAULT_PRICING's own doc comment)
    // makes a real under-charge visible in logs instead of silent.
    console.warn(
      `[model-catalog] calculateLLMCreditCost: no pricing for "${modelId}" — ` +
        `billing at DEFAULT_PRICING (inputPer1M ${DEFAULT_PRICING.inputPer1M}, ` +
        `outputPer1M ${DEFAULT_PRICING.outputPer1M}). If this model has a real, ` +
        `higher provider cost, this under-charges until it gets a pricing row.`
    )
  }
  const cacheRead = pricing.cacheReadMultiplier ?? 1.0
  const cacheWrite = pricing.cacheWriteMultiplier ?? 1.0

  const cacheReadIn = Math.max(0, usage.cacheReadInputTokens ?? 0)
  const cacheCreateIn = Math.max(0, usage.cacheCreationInputTokens ?? 0)

  // ── 1. Provider cost (USD) — single source of truth ──
  // Cache multipliers apply to BOTH the provider cost AND the derived
  // credit cost. Margin holds across cached vs uncached tokens because
  // `creditPerToken = providerCostPerToken × markup × cacheMultiplier`.
  const inputUsd = (usage.inputTokens / 1_000_000) * pricing.inputPer1M
  const cacheReadUsd =
    (cacheReadIn / 1_000_000) * pricing.inputPer1M * cacheRead
  const cacheWriteUsd =
    (cacheCreateIn / 1_000_000) * pricing.inputPer1M * cacheWrite
  const outputUsd = (usage.outputTokens / 1_000_000) * pricing.outputPer1M
  const productionCost = inputUsd + cacheReadUsd + cacheWriteUsd + outputUsd

  // ── 2. Markup resolution ──
  const markup =
    opts.markupOverride ??
    ENV_MARKUP_OVERRIDE ??
    pricingRegistry.getMarkup("text", opts.appId)

  // ── 3. Pure-formula credit math in **centicredits** (no overrides —
  // always computed for analytics / Langfuse reconciliation). Per-
  // component ceil keeps token rounding stable; at 1-cc precision the
  // rounding overhead is negligible vs the cost.
  const formulaInputCredits = Math.ceil((inputUsd * markup) / CC_USD_RATE)
  const formulaCacheReadCredits = Math.ceil(
    (cacheReadUsd * markup) / CC_USD_RATE
  )
  const formulaCacheWriteCredits = Math.ceil(
    (cacheWriteUsd * markup) / CC_USD_RATE
  )
  const formulaOutputCredits = Math.ceil((outputUsd * markup) / CC_USD_RATE)
  const formulaSubtotal =
    formulaInputCredits +
    formulaCacheReadCredits +
    formulaCacheWriteCredits +
    formulaOutputCredits
  const calculatedCredits = Math.max(formulaSubtotal, MIN_CREDITS_PER_TURN_CC)

  // ── 4. Charged credits — honor explicit per-model centicredit
  // override (`overrideCredit*Per1M`). Use only for strategic
  // deviations (loss-leaders / promos). The default formula path is
  // cost-plus-margin by construction.
  const inputOverrideCc = pricing.overrideCreditInputPer1M
  const outputOverrideCc = pricing.overrideCreditOutputPer1M
  const hasOverride =
    inputOverrideCc !== undefined || outputOverrideCc !== undefined

  const inputCredits =
    inputOverrideCc !== undefined
      ? Math.ceil((usage.inputTokens / 1_000_000) * inputOverrideCc)
      : formulaInputCredits
  const cacheReadCredits =
    inputOverrideCc !== undefined
      ? Math.ceil((cacheReadIn / 1_000_000) * inputOverrideCc * cacheRead)
      : formulaCacheReadCredits
  const cacheWriteCredits =
    inputOverrideCc !== undefined
      ? Math.ceil((cacheCreateIn / 1_000_000) * inputOverrideCc * cacheWrite)
      : formulaCacheWriteCredits
  const outputCredits =
    outputOverrideCc !== undefined
      ? Math.ceil((usage.outputTokens / 1_000_000) * outputOverrideCc)
      : formulaOutputCredits

  const subtotal =
    inputCredits + cacheReadCredits + cacheWriteCredits + outputCredits
  const credits = Math.max(subtotal, MIN_CREDITS_PER_TURN_CC)

  return {
    credits,
    calculatedCredits,
    inputCredits,
    outputCredits,
    cacheReadCredits,
    cacheWriteCredits,
    productionCost,
    pricing,
    isFallback,
    markup,
    hasOverride,
  }
}

// ─── Cache stats ─────────────────────────────────────────────────────────

export interface CacheStats {
  /**
   * Cache hit rate as a 0..1 fraction of total input tokens (raw + cache
   * read + cache create). 0 means no cache activity, 1 means everything
   * read from cache, 0 for output-only calls. `null` when there were no
   * input tokens at all.
   */
  cacheHitRate: number | null
  /**
   * Provider USD we *saved* vs the same input billed at the uncached
   * rate. Cache reads at 0.1× save 0.9× of the input cost; cache writes
   * at 1.25× actually COST 0.25× more than uncached (negative savings).
   * Sum across both. Negative means cache-write overhead exceeded
   * cache-read savings (rare — usually means the prompt prefix was
   * cached on the first turn but never re-used).
   */
  providerCostSavedUsd: number
  /**
   * Centicredits the user *saved* vs the same input billed at the
   * uncached rate. Same sign convention as `providerCostSavedUsd`.
   * Unit: cc (format with `displayCredits(cc)` for UI).
   */
  creditsSaved: number
  /**
   * True iff the model carries cache multipliers in its pricing.
   * Useful for explaining "this model doesn't support caching" in UI.
   */
  cacheSupported: boolean
}

/**
 * Turn a credit-cost result into cache-utilisation stats. Pure compute.
 *
 * Use cases:
 *   - "Cache saved 87% on this call" in a UI tooltip.
 *   - Per-conversation dashboards: "across this conversation, prompt
 *     caching saved you $0.42 / 12 credits."
 *   - Regression alarms — if cacheHitRate drops below an expected
 *     threshold on a known-cacheable workload, something broke in
 *     prompt-prefix stability.
 *
 * Returns `cacheSupported: false` for models without cache multipliers
 * (gpt-4o-mini, gemini, mistral) — all fields are zero in that case
 * (no cache activity is possible).
 */
export function getCacheStats(
  modelId: string,
  usage: LLMUsageBreakdown,
  opts?: CalculateLLMCreditCostOptions
): CacheStats {
  const result = calculateLLMCreditCost(modelId, usage, opts)
  const cacheRead = result.pricing.cacheReadMultiplier ?? 1.0
  const cacheWrite = result.pricing.cacheWriteMultiplier ?? 1.0
  const cacheSupported =
    result.pricing.cacheReadMultiplier !== undefined ||
    result.pricing.cacheWriteMultiplier !== undefined

  const rawInput = Math.max(0, usage.inputTokens)
  const cacheReadIn = Math.max(0, usage.cacheReadInputTokens ?? 0)
  const cacheWriteIn = Math.max(0, usage.cacheCreationInputTokens ?? 0)
  const totalInput = rawInput + cacheReadIn + cacheWriteIn

  const cacheHitRate =
    totalInput === 0 ? null : (cacheReadIn + cacheWriteIn) / totalInput

  // What the cached tokens WOULD have cost at the uncached rate.
  // Savings = uncached cost − actual cost. Cache reads save (1-cacheRead)
  // of their token-equivalent input cost; cache writes save (1-cacheWrite),
  // which is negative for cacheWrite > 1.0.
  const uncachedCacheReadUsd =
    (cacheReadIn / 1_000_000) * result.pricing.inputPer1M
  const uncachedCacheWriteUsd =
    (cacheWriteIn / 1_000_000) * result.pricing.inputPer1M
  const actualCacheReadUsd = uncachedCacheReadUsd * cacheRead
  const actualCacheWriteUsd = uncachedCacheWriteUsd * cacheWrite

  const providerCostSavedUsd =
    uncachedCacheReadUsd -
    actualCacheReadUsd +
    (uncachedCacheWriteUsd - actualCacheWriteUsd)

  // Credit-side savings mirror provider-side: cache multiplier × markup
  // = total discount applied to the user's bill. All math in cc.
  const inputRateCc =
    result.pricing.overrideCreditInputPer1M ??
    Math.ceil((result.pricing.inputPer1M * result.markup) / CC_USD_RATE)
  const uncachedCacheReadCredits = (cacheReadIn / 1_000_000) * inputRateCc
  const uncachedCacheWriteCredits = (cacheWriteIn / 1_000_000) * inputRateCc
  const creditsSaved =
    uncachedCacheReadCredits -
    result.cacheReadCredits +
    (uncachedCacheWriteCredits - result.cacheWriteCredits)

  return {
    cacheHitRate,
    providerCostSavedUsd,
    creditsSaved,
    cacheSupported,
  }
}

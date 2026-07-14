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
}

import { OPENROUTER_ROUTES } from "./openrouter-routes.generated.js"
import { pricingRegistry, CC_USD_RATE } from "../pricing/index.js"

export const LLM_PRICING_CATALOG = {
  // ── Anthropic ──────────────────────────────────────────────────────────
  // Catalog keys MUST be valid Anthropic model ids — `resolveAlias` returns
  // the catalog key as the API model id, and Anthropic 404s on anything
  // that isn't a real published id (e.g. the bare `claude-sonnet-4`
  // collapsed every Sonnet 4.x request through to a not_found_error).
  "claude-opus-4-5": {
    inputPer1M: 15.0,
    outputPer1M: 75.0,
    cacheReadMultiplier: 0.1,
    cacheWriteMultiplier: 1.25,
    vendor: "anthropic",
    provider: "anthropic",
  },
  "claude-sonnet-4-5": {
    inputPer1M: 3.0,
    outputPer1M: 15.0,
    cacheReadMultiplier: 0.1,
    cacheWriteMultiplier: 1.25,
    vendor: "anthropic",
    provider: "anthropic",
  },
  "claude-haiku-4-5": {
    inputPer1M: 0.8,
    outputPer1M: 4.0,
    cacheReadMultiplier: 0.1,
    cacheWriteMultiplier: 1.25,
    vendor: "anthropic",
    provider: "anthropic",
  },
  // Latest-generation Anthropic ids the claude-code / claude-sdk adapters
  // advertise. Registered so `agentproto models` reports a $/Mtok figure and
  // a concrete provider — before these rows they resolved to provider
  // `unknown` (no pricing entry) and showed as runnable:false. Prices per 1M
  // tokens from platform.claude.com/docs/en/pricing.
  "claude-opus-4-8": {
    inputPer1M: 5.0,
    outputPer1M: 25.0,
    cacheReadMultiplier: 0.1,
    cacheWriteMultiplier: 1.25,
    vendor: "anthropic",
    provider: "anthropic",
  },
  "claude-sonnet-5": {
    inputPer1M: 3.0,
    outputPer1M: 15.0,
    cacheReadMultiplier: 0.1,
    cacheWriteMultiplier: 1.25,
    vendor: "anthropic",
    provider: "anthropic",
  },
  "claude-fable-5": {
    inputPer1M: 10.0,
    outputPer1M: 50.0,
    cacheReadMultiplier: 0.1,
    cacheWriteMultiplier: 1.25,
    vendor: "anthropic",
    provider: "anthropic",
  },

  // ── Google ─────────────────────────────────────────────────────────────
  // Source: https://ai.google.dev/gemini-api/docs/pricing (fetched 2026-05-29)
  // — Flash text/image/video input $0.30/1M, output $2.50/1M, context-cache
  // $0.03/1M (audio input is $1.00/1M — not modeled). Cross-checked against
  // https://pricepertoken.com/pricing-page/model/google-gemini-2.5-flash.
  "gemini-2.5-flash": {
    inputPer1M: 0.3,
    outputPer1M: 2.5,
    // Context-cache $0.03/1M = 0.1× input (implicit caching, no write surcharge).
    cacheReadMultiplier: 0.1,
    vendor: "google",
    provider: "google",
  },
  // Source: https://ai.google.dev/gemini-api/docs/pricing (fetched 2026-05-29)
  // — Pro ≤200k prompts: input $1.25/1M, output $10.00/1M, context-cache
  // $0.125/1M. (>200k tiers: $2.50 in / $15.00 out — not modeled.)
  "gemini-2.5-pro": {
    inputPer1M: 1.25,
    outputPer1M: 10.0,
    // Context-cache $0.125/1M = 0.1× input (≤200k tier).
    cacheReadMultiplier: 0.1,
    vendor: "google",
    provider: "google",
  },
  // Source: https://ai.google.dev/gemini-api/docs/pricing (fetched 2026-05-29)
  // — Gemini 3.5 Flash input $1.50/1M, output $9.00/1M, context-cache
  // $0.15/1M. Cross-checked against https://devtk.ai/en/models/gemini-3-5-flash.
  "gemini-3.5-flash": {
    inputPer1M: 1.5,
    outputPer1M: 9.0,
    // Context-cache $0.15/1M = 0.1× input.
    cacheReadMultiplier: 0.1,
    vendor: "google",
    provider: "google",
  },
  // Source: https://ai.google.dev/gemini-api/docs/pricing (fetched 2026-05-29)
  // — Flash-Lite text/image/video input $0.10/1M, output $0.40/1M, cache $0.01.
  "gemini-2.5-flash-lite": {
    inputPer1M: 0.1,
    outputPer1M: 0.4,
    // Context-cache $0.01/1M = 0.1× input.
    cacheReadMultiplier: 0.1,
    vendor: "google",
    provider: "google",
  },
  // Source: https://ai.google.dev/gemini-api/docs/pricing (fetched 2026-05-29)
  // — Gemini 3.1 Pro Preview ≤200k prompts: input $2.00/1M, output $12.00/1M,
  // context-cache $0.20/1M. (>200k tiers: $4.00 in / $18.00 out — not modeled.)
  "gemini-3.1-pro-preview": {
    inputPer1M: 2.0,
    outputPer1M: 12.0,
    // Context-cache $0.20/1M = 0.1× input (≤200k tier).
    cacheReadMultiplier: 0.1,
    vendor: "google",
    provider: "google",
  },
  // Source: https://ai.google.dev/gemini-api/docs/pricing (fetched 2026-05-29)
  // — Gemini 3 Flash Preview text/image/video input $0.50/1M, output $3.00/1M,
  // context-cache $0.05/1M.
  "gemini-3-flash-preview": {
    inputPer1M: 0.5,
    outputPer1M: 3.0,
    // Context-cache $0.05/1M = 0.1× input.
    cacheReadMultiplier: 0.1,
    vendor: "google",
    provider: "google",
  },
  // Source: https://ai.google.dev/gemini-api/docs/pricing (fetched 2026-05-29)
  // — Gemini 3.1 Flash-Lite text/image/video input $0.25/1M, output $1.50/1M,
  // context-cache $0.025/1M.
  "gemini-3.1-flash-lite": {
    inputPer1M: 0.25,
    outputPer1M: 1.5,
    // Context-cache $0.025/1M = 0.1× input.
    cacheReadMultiplier: 0.1,
    vendor: "google",
    provider: "google",
  },

  // ── OpenAI ─────────────────────────────────────────────────────────────
  // All OpenAI cacheReadMultiplier = 0.1 (cached input billed at 10% of base,
  // matching the per-model cached-input rates on the pricing table). No cache-
  // write premium (OpenAI prompt caching is automatic, no write surcharge).
  // Source: https://pricepertoken.com/pricing-page/provider/openai
  // (mirrors openai.com/api/pricing; fetched 2026-05-29 — openai.com 403s WebFetch).
  "gpt-5.5": {
    // $5.00 in / $0.50 cached / $30.00 out per 1M.
    inputPer1M: 5.0,
    outputPer1M: 30.0,
    cacheReadMultiplier: 0.1,
    vendor: "openai",
    provider: "openai",
  },
  "gpt-5.5-pro": {
    // $30.00 in / $180.00 out per 1M. No cached tier on pro.
    inputPer1M: 30.0,
    outputPer1M: 180.0,
    vendor: "openai",
    provider: "openai",
  },
  "gpt-5.4": {
    // $2.50 in / $0.25 cached / $15.00 out per 1M (production workhorse).
    inputPer1M: 2.5,
    outputPer1M: 15.0,
    cacheReadMultiplier: 0.1,
    vendor: "openai",
    provider: "openai",
  },
  "gpt-5.4-mini": {
    // $0.75 in / $0.075 cached / $4.50 out per 1M.
    inputPer1M: 0.75,
    outputPer1M: 4.5,
    cacheReadMultiplier: 0.1,
    vendor: "openai",
    provider: "openai",
  },
  "gpt-5.4-nano": {
    // $0.20 in / $0.02 cached / $1.25 out per 1M.
    inputPer1M: 0.2,
    outputPer1M: 1.25,
    cacheReadMultiplier: 0.1,
    vendor: "openai",
    provider: "openai",
  },
  "gpt-5.4-pro": {
    // $30.00 in / $180.00 out per 1M. No cached tier on pro.
    inputPer1M: 30.0,
    outputPer1M: 180.0,
    vendor: "openai",
    provider: "openai",
  },
  "gpt-5.2": {
    // $1.75 in / $0.175 cached / $14.00 out per 1M.
    inputPer1M: 1.75,
    outputPer1M: 14.0,
    cacheReadMultiplier: 0.1,
    vendor: "openai",
    provider: "openai",
  },
  "gpt-5.1": {
    // $1.25 in / $0.125 cached / $10.00 out per 1M.
    inputPer1M: 1.25,
    outputPer1M: 10.0,
    cacheReadMultiplier: 0.1,
    vendor: "openai",
    provider: "openai",
  },
  "gpt-5": {
    // $1.25 in / $0.125 cached / $10.00 out per 1M (base GPT-5).
    inputPer1M: 1.25,
    outputPer1M: 10.0,
    cacheReadMultiplier: 0.1,
    vendor: "openai",
    provider: "openai",
  },
  "gpt-4.1": {
    inputPer1M: 2.0,
    outputPer1M: 8.0,
    vendor: "openai",
    provider: "openai",
  },
  "gpt-4.1-mini": {
    inputPer1M: 0.4,
    outputPer1M: 1.6,
    vendor: "openai",
    provider: "openai",
  },
  // Source: pricepertoken.com/pricing-page/provider/openai (fetched 2026-05-29)
  // — gpt-4.1-nano $0.10 in / $0.025 cached / $0.40 out per 1M.
  "gpt-4.1-nano": {
    inputPer1M: 0.1,
    outputPer1M: 0.4,
    cacheReadMultiplier: 0.25,
    vendor: "openai",
    provider: "openai",
  },
  "gpt-4o": {
    inputPer1M: 2.5,
    outputPer1M: 10.0,
    vendor: "openai",
    provider: "openai",
  },
  "gpt-4o-mini": {
    inputPer1M: 0.15,
    outputPer1M: 0.6,
    vendor: "openai",
    provider: "openai",
  },
  // ── OpenAI o-series (reasoning) ─────────────────────────────────────────
  // Source: pricepertoken.com/pricing-page/provider/openai (fetched 2026-05-29).
  o3: {
    // $2.00 in / $8.00 out per 1M.
    inputPer1M: 2.0,
    outputPer1M: 8.0,
    vendor: "openai",
    provider: "openai",
  },
  "o4-mini": {
    // $0.55 in / $0.275 cached / $2.20 out per 1M.
    inputPer1M: 0.55,
    outputPer1M: 2.2,
    cacheReadMultiplier: 0.5,
    vendor: "openai",
    provider: "openai",
  },
  "o3-mini": {
    // $0.55 in / $2.20 out per 1M (no cache discount listed).
    inputPer1M: 0.55,
    outputPer1M: 2.2,
    vendor: "openai",
    provider: "openai",
  },
  o1: {
    // $15.00 in / $7.50 cached / $60.00 out per 1M.
    inputPer1M: 15.0,
    outputPer1M: 60.0,
    cacheReadMultiplier: 0.5,
    vendor: "openai",
    provider: "openai",
  },
  "o1-mini": {
    // $0.55 in / $2.20 out per 1M.
    inputPer1M: 0.55,
    outputPer1M: 2.2,
    vendor: "openai",
    provider: "openai",
  },

  // ── MiniMax (direct SDK) ───────────────────────────────────────────────
  // Bare ids match what the MiniMax SDK expects on the wire (PascalCase
  // with optional minor version). OpenRouter equivalents under
  // `minimax/minimax-m2*` are separate entries auto-imported below; the
  // runtime connector picks which one to call based on the guild's
  // installed connectors.
  "MiniMax-M2": {
    inputPer1M: 0.2,
    outputPer1M: 1.0,
    cacheReadMultiplier: 0.15,
    cacheWriteMultiplier: 1.875,
    vendor: "minimax",
    provider: "minimax",
  },
  "M2-her": {
    inputPer1M: 0.2,
    outputPer1M: 1.0,
    cacheReadMultiplier: 0.15,
    cacheWriteMultiplier: 1.875,
    vendor: "minimax",
    provider: "minimax",
  },
  "MiniMax-M2.1": {
    inputPer1M: 0.3,
    outputPer1M: 1.2,
    cacheReadMultiplier: 0.1,
    cacheWriteMultiplier: 1.25,
    vendor: "minimax",
    provider: "minimax",
  },
  "MiniMax-M2.5": {
    inputPer1M: 0.3,
    outputPer1M: 1.2,
    cacheReadMultiplier: 0.1,
    cacheWriteMultiplier: 1.25,
    vendor: "minimax",
    provider: "minimax",
  },
  "MiniMax-M2.7": {
    inputPer1M: 0.3,
    outputPer1M: 1.2,
    vendor: "minimax",
    provider: "minimax",
  },

  // ── Moonshot (direct SDK) ─────────────────────────────────────────────
  "kimi-k2.6": {
    inputPer1M: 0.95,
    outputPer1M: 4.0,
    cacheReadMultiplier: 0.17,
    vendor: "moonshot",
    provider: "moonshot",
  },
  "kimi-k2.5": {
    inputPer1M: 0.6,
    outputPer1M: 3.0,
    cacheReadMultiplier: 0.17,
    vendor: "moonshot",
    provider: "moonshot",
  },
  "kimi-k2-0905-preview": {
    inputPer1M: 0.6,
    outputPer1M: 2.5,
    cacheReadMultiplier: 0.25,
    vendor: "moonshot",
    provider: "moonshot",
  },
  "kimi-k2-turbo-preview": {
    inputPer1M: 1.15,
    outputPer1M: 8.0,
    cacheReadMultiplier: 0.13,
    vendor: "moonshot",
    provider: "moonshot",
  },
  "kimi-k2-thinking": {
    inputPer1M: 0.6,
    outputPer1M: 2.5,
    cacheReadMultiplier: 0.25,
    vendor: "moonshot",
    provider: "moonshot",
  },
  "kimi-k2-thinking-turbo": {
    inputPer1M: 1.15,
    outputPer1M: 8.0,
    cacheReadMultiplier: 0.13,
    vendor: "moonshot",
    provider: "moonshot",
  },

  // ── xAI (direct SDK + proxy) ─────────────────────────────────────────
  // Source: https://docs.x.ai/docs/models (fetched 2026-07-14)
  // Pricing from API: prompt_text_token_price / completion_text_token_price
  // in units per 1 token. Converted to $ per 1M tokens.
  "grok-4.5": {
    // $2.00 in / $6.00 out per 1M (flagship).
    inputPer1M: 2.0,
    outputPer1M: 6.0,
    vendor: "xai",
    provider: "xai",
  },
  "grok-4.20": {
    // $1.25 in / $2.50 out per 1M (non-reasoning default).
    inputPer1M: 1.25,
    outputPer1M: 2.5,
    vendor: "xai",
    provider: "xai",
  },
  "grok-4.20-reasoning": {
    // Same pricing as grok-4.20, reasoning variant.
    inputPer1M: 1.25,
    outputPer1M: 2.5,
    vendor: "xai",
    provider: "xai",
  },
  "grok-4.20-multi-agent": {
    // Same pricing as grok-4.20.
    inputPer1M: 1.25,
    outputPer1M: 2.5,
    vendor: "xai",
    provider: "xai",
  },
  "grok-4.3": {
    // $1.25 in / $2.50 out per 1M (alias: grok-latest).
    inputPer1M: 1.25,
    outputPer1M: 2.5,
    vendor: "xai",
    provider: "xai",
  },
  "grok-build-0.1": {
    // $1.00 in / $2.00 out per 1M (code/fast variant, 256k context).
    inputPer1M: 1.0,
    outputPer1M: 2.0,
    vendor: "xai",
    provider: "xai",
  },

  // ── Mistral (direct SDK) ──────────────────────────────────────────────
  "mistral-large-latest": {
    inputPer1M: 0.5,
    outputPer1M: 1.5,
    vendor: "mistral",
    provider: "mistral",
  },
  "mistral-small-creative-latest": {
    inputPer1M: 0.1,
    outputPer1M: 0.3,
    vendor: "mistral",
    provider: "mistral",
  },
  "mistral-small-2501": {
    inputPer1M: 0.05,
    outputPer1M: 0.08,
    vendor: "mistral",
    provider: "mistral",
  },
  "mistral-small-latest": {
    inputPer1M: 0.06,
    outputPer1M: 0.18,
    cacheReadMultiplier: 0.5,
    vendor: "mistral",
    provider: "mistral",
  },

  // ── OpenRouter routes — generated by `scripts/catalog-sync` from
  // https://openrouter.ai/api/v1/models. Re-run
  // `pnpm --filter @agentproto/catalog-sync sync:openrouter`
  // to refresh.
  ...OPENROUTER_ROUTES,
} satisfies Record<string, LLMPricing>

/**
 * Every canonical catalog model id — derived straight from the pricing
 * map keys (`satisfies` above preserves the literal keys). Downstream
 * curation/config should constrain their ids to this so a typo or a
 * removed model is a build error, not a broken row at runtime.
 */
export type LlmModelId = keyof typeof LLM_PRICING_CATALOG

// ── Aliases (map model IDs to catalog keys) ─────────────────────────────

export const MODEL_ALIASES = {
  // Anthropic — alias targets must be real Anthropic model ids since
  // `resolveAlias` feeds the result straight to the SDK.
  "claude-opus-4-6": "claude-opus-4-5",
  "claude-sonnet-4-6": "claude-sonnet-4-5",
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
  // Mistral
  "mistralai/mistral-large-latest": "mistral-large-latest",
  "mistralai/mistral-small-latest": "mistral-small-latest",
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
  return resolvePricing(modelId)?.provider
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

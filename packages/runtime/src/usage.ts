/**
 * Per-session usage snapshot — the single place that decides a session's
 * `costUsd` and where that number came from.
 *
 * Two cost sources feed a session:
 *   - an adapter's own usage reader (`readUsage`, e.g. hermes reads its
 *     state.db) or an ACP `usage_update` that carries a `cost` block — these
 *     are authoritative, tagged `source: "adapter"`.
 *   - raw input/output token counts with NO adapter cost (ACP adapters like
 *     claude-code / mastracode that report tokens but not dollars) — here we
 *     price them ourselves against agentproto's in-repo LLM pricing catalog,
 *     tagged `source: "computed"`.
 *
 * When tokens exist but the model is absent from the catalog we NEVER
 * fabricate a price: `costUsd` is left undefined and the snapshot is tagged
 * `source: "no-pricing"`. A session with neither cost nor tokens is
 * `source: "none"`.
 *
 * This module is pure (the catalog lookup is injected) so the decision tree is
 * unit-testable without building the whole model catalog.
 */

import { resolvePricing } from "@agentproto/model-catalog/llm"

/** Where a session's `costUsd` came from — see the module doc. */
export type UsageSource = "adapter" | "computed" | "no-pricing" | "none"

/** Per-token USD prices for a model (per 1M tokens), the subset of the
 *  catalog's `LLMPricing` this module needs. */
export interface TokenPricing {
  inputPer1M: number
  outputPer1M: number
}

/** Pluggable pricing accessor — defaults to the in-repo catalog's
 *  `resolvePricing`, overridable in tests. Returns undefined for an
 *  unknown model (the caller then tags `no-pricing`). */
export type PricingResolver = (model: string) => TokenPricing | undefined

/** Raw signals gathered over a turn, handed to `deriveSessionUsage`. */
export interface UsageComputeInput {
  /** Requested model id — needed to look up per-token prices. */
  model?: string
  /** Cost the adapter reported directly (readUsage or usage_update.cost).
   *  Present → authoritative, wins over token-based computation. */
  adapterCostUsd?: number
  tokensIn?: number
  tokensOut?: number
  contextSize?: number
  contextUsed?: number
}

/** The resolved usage snapshot — the shape `session_usage` returns and the
 *  durable `usage_snapshot` transcript record carries. Cost/token fields are
 *  omitted when absent so a missing value never reads as a measured zero. */
export interface SessionUsage {
  model?: string
  costUsd?: number
  tokensIn?: number
  tokensOut?: number
  contextSize?: number
  contextUsed?: number
  source: UsageSource
}

/**
 * A `contextUsed` greater than the reported `contextSize` cannot be tokens
 * currently occupying the context window — a window can't hold more tokens
 * than it is wide. At least one adapter's ACP server has been observed
 * putting a cumulative session-lifetime token total in this field instead
 * of a point-in-time occupancy figure (a long-running session's running
 * total can land tens of times past a fixed window, e.g. 14.2M reported
 * against a 200K window). A value that fails this check is provably not
 * what the field claims to be, so it's dropped rather than clamped: an
 * absent `contextUsed` reads as "unmeasured," a clamped one would read as
 * a plausible but fabricated occupancy percentage. `contextSize` itself is
 * untouched — it's a static model property, not the corrupted signal.
 *
 * When `contextSize` isn't known yet, `contextUsed` can't be disproven —
 * it's passed through unchanged rather than discarded.
 */
export function plausibleContextUsed(
  contextSize: number | undefined,
  contextUsed: number | undefined,
): number | undefined {
  if (contextUsed === undefined) return undefined
  if (contextSize !== undefined && contextUsed > contextSize) return undefined
  return contextUsed
}

const defaultResolver: PricingResolver = model => resolvePricing(model)

/** Cost of `tokens` at `pricePer1M` USD/1M tokens. */
function tokenCost(tokens: number | undefined, pricePer1M: number): number {
  return tokens === undefined ? 0 : (tokens * pricePer1M) / 1_000_000
}

/**
 * Decide a session's usage snapshot + cost source from the raw signals.
 *
 * Priority: an adapter-reported cost wins; else price the tokens against the
 * catalog; else `none`. Never fabricates a price for an unpriced model.
 */
export function deriveSessionUsage(
  input: UsageComputeInput,
  resolve: PricingResolver = defaultResolver,
): SessionUsage {
  // Re-validated here, not just at usage_update ingestion: a rejected
  // ingress update leaves whatever was already on the descriptor in place
  // rather than clearing it, so a stale out-of-window value written before
  // that guard existed (or reloaded from a pre-guard persisted snapshot)
  // can still reach this call at a session's exit-time recap. Same
  // reasoning as `plausibleContextUsed`'s own doc comment — drop, don't
  // clamp.
  const contextUsed = plausibleContextUsed(input.contextSize, input.contextUsed)
  const base: Omit<SessionUsage, "source" | "costUsd"> = {
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.tokensIn !== undefined ? { tokensIn: input.tokensIn } : {}),
    ...(input.tokensOut !== undefined ? { tokensOut: input.tokensOut } : {}),
    ...(input.contextSize !== undefined ? { contextSize: input.contextSize } : {}),
    ...(contextUsed !== undefined ? { contextUsed } : {}),
  }

  // 1. Adapter reported a cost directly — authoritative.
  if (input.adapterCostUsd !== undefined) {
    return { ...base, costUsd: input.adapterCostUsd, source: "adapter" }
  }

  // 2. We have token counts — price them against the in-repo catalog.
  const hasTokens = input.tokensIn !== undefined || input.tokensOut !== undefined
  if (hasTokens) {
    const pricing = input.model !== undefined ? resolve(input.model) : undefined
    if (!pricing) {
      // Model absent from the catalog — surface the tokens, but NEVER
      // invent a dollar figure.
      return { ...base, source: "no-pricing" }
    }
    const costUsd =
      tokenCost(input.tokensIn, pricing.inputPer1M) +
      tokenCost(input.tokensOut, pricing.outputPer1M)
    return { ...base, costUsd, source: "computed" }
  }

  // 3. Neither cost nor tokens — nothing measured.
  return { ...base, source: "none" }
}

/** Descriptor-shaped fields `projectSessionUsage` reads. */
export interface UsageDescriptorFields {
  model?: string
  costUsd?: number
  tokensIn?: number
  tokensOut?: number
  contextSize?: number
  contextUsed?: number
  usageSource?: UsageSource
}

/**
 * Project a session descriptor's persisted usage fields into the
 * `session_usage` response shape. Omits absent fields; defaults an
 * unstamped `usageSource` to `"none"`.
 */
export function projectSessionUsage(desc: UsageDescriptorFields): SessionUsage {
  // Same re-validation as `deriveSessionUsage`, for the same reason: this
  // formats a descriptor that may have been reloaded from a persisted
  // snapshot written before `plausibleContextUsed` existed — a session
  // that's already dead never gets a fresh usage_update to self-correct
  // it, so a stale out-of-window value would otherwise surface forever.
  const contextUsed = plausibleContextUsed(desc.contextSize, desc.contextUsed)
  return {
    ...(desc.model !== undefined ? { model: desc.model } : {}),
    ...(desc.costUsd !== undefined ? { costUsd: desc.costUsd } : {}),
    ...(desc.tokensIn !== undefined ? { tokensIn: desc.tokensIn } : {}),
    ...(desc.tokensOut !== undefined ? { tokensOut: desc.tokensOut } : {}),
    ...(desc.contextSize !== undefined ? { contextSize: desc.contextSize } : {}),
    ...(contextUsed !== undefined ? { contextUsed } : {}),
    source: desc.usageSource ?? "none",
  }
}

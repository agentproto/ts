/**
 * Access evaluator — resolves whether a workspace can use a given model.
 *
 * Resolution order:
 *   1. App scope — if the app opts out of the model's kind, deny.
 *   2. Workspace explicit `model:<id>` rule — terminal allow or block.
 *   3. Workspace tag / provider / priceTier / kind rules — most-specific
 *      band wins. Within a band, block wins. Specificity ladder:
 *        tag (4) > provider (3) > priceTier (2) > kind (1).
 *      Rationale: an explicit `allow tag:image:generate` should beat a
 *      blanket `block kind:llm`. The tag rule is the more specific
 *      intent and reflects the operator's allowlist.
 *   4. Catalog defaults — `lifecycle=stable && agentVisible=true` → allow.
 *
 * BYOK relaxation: when `byokActive`, `priceTier=premium` blocks are
 * bypassed (BYOK users pay providers directly). NSFW / compliance
 * blocks NEVER bypass.
 */

import type { ResolvedModel } from "../registry/index.js"
import { modelHasTag, modelMatchesPriceTier } from "../enrichment/index.js"
import { evaluateCatalogDefaults } from "./catalog-defaults.js"
import type { AccessRule, AppScope } from "./types.js"

/**
 * Specificity of non-model rule targets. Higher = more specific.
 * Most-specific band wins; within a band, block wins.
 *
 * Mirrors the scope specificity logic in
 * `packages/core/src/domain/model-access/types.ts:79`.
 */
const NON_MODEL_SPECIFICITY: Record<
  "tag" | "provider" | "priceTier" | "kind",
  number
> = {
  tag: 4,
  provider: 3,
  priceTier: 2,
  kind: 1,
}

export interface AccessEvalInput {
  model: ResolvedModel
  appScope?: AppScope
  /** Workspace overrides; v1 callers pass `[]`. */
  rules?: AccessRule[]
  byokActive?: boolean
}

export interface AccessDecision {
  allowed: boolean
  /** Stable token for logs/metrics. */
  reason: string
}

const NSFW_TAG_BLOCK_REASONS = new Set(["nsfw", "compliance"])

/**
 * Returns true iff the rule matches the resolved model.
 *
 * Tag and priceTier matching go through the enrichment layer
 * (`@agstudio/model-catalog/enrichment`) — explicit per-model
 * enrichment wins, heuristic fallback fills the rest.
 */
function ruleMatches(rule: AccessRule, model: ResolvedModel): boolean {
  const target = rule.target
  switch (target.kind) {
    case "model":
      return target.id === model.id
    case "kind":
      return target.value === model.kind
    case "provider": {
      switch (model.kind) {
        case "image":
          return model.def.provider === target.value
        case "video":
          return model.def.provider === target.value
        case "audio":
          return model.def.provider === target.value
        case "voice":
          return model.voice.provider === target.value
        case "llm":
          // No provider field on LLM entries — best-effort by id prefix.
          return (
            model.canonicalId.startsWith(`${target.value}/`) ||
            model.canonicalId.includes(target.value)
          )
      }
    }
    case "tag":
      return modelHasTag(model, target.value)
    case "priceTier":
      return modelMatchesPriceTier(model, target.value)
  }
}

export function evaluateAccess(input: AccessEvalInput): AccessDecision {
  const { model, appScope, rules = [], byokActive = false } = input

  // 1. App scope. `voice` rows are metadata, not callable models — they
  // bypass kind-scope checks (gating happens on the audio MODEL the
  // voice plays through).
  if (
    appScope &&
    appScope.kinds.length > 0 &&
    model.kind !== "voice" &&
    !appScope.kinds.includes(model.kind)
  ) {
    return {
      allowed: false,
      reason: `app-scope:kind-not-allowed:${model.kind}`,
    }
  }

  // 2. Explicit per-model rules. Most specific band — terminal if any
  // matches. Within the band, block wins over allow (so a workspace
  // `block model:X` beats a tier-policy `allow model:X` regardless of
  // the order they appear in the merged rule list).
  const modelMatches = rules.filter(
    r =>
      r.target.kind === "model" && (r.target as { id: string }).id === model.id
  )
  if (modelMatches.length > 0) {
    const winner =
      modelMatches.find(r => r.effect === "block") ?? modelMatches[0]!
    return {
      allowed: winner.effect === "allow",
      reason: `rule:model:${winner.effect}${winner.reason ? `:${winner.reason}` : ""}`,
    }
  }

  // 3. Tag / provider / priceTier / kind rules. Most-specific band wins;
  // within a band, block wins. BYOK relaxation drops priceTier=premium
  // blocks before specificity grouping.
  const matchedByBand = new Map<number, AccessRule[]>()
  for (const rule of rules) {
    const k = rule.target.kind
    if (k === "model") continue
    if (!ruleMatches(rule, model)) continue
    if (rule.effect === "block") {
      // BYOK relaxation — same condition as before the refactor.
      if (
        byokActive &&
        rule.target.kind === "priceTier" &&
        rule.target.value === "premium" &&
        !NSFW_TAG_BLOCK_REASONS.has(rule.reason ?? "")
      ) {
        continue
      }
    }
    const band = NON_MODEL_SPECIFICITY[k]
    const list = matchedByBand.get(band) ?? []
    list.push(rule)
    matchedByBand.set(band, list)
  }

  if (matchedByBand.size > 0) {
    // Walk bands from most-specific to least-specific. The first band
    // with any matching rule decides — block wins within the band.
    const bands = Array.from(matchedByBand.keys()).sort((a, b) => b - a)
    for (const band of bands) {
      const bandRules = matchedByBand.get(band)!
      const blocked = bandRules.find(r => r.effect === "block")
      const allowed = bandRules.find(r => r.effect === "allow")
      const winner = blocked ?? allowed
      if (!winner) continue
      const t = winner.target
      const targetStr =
        t.kind === "model"
          ? `model:${(t as { id: string }).id}`
          : `${t.kind}:${(t as { value: string }).value}`
      const tail = winner.reason ? `:${winner.reason}` : ""
      return {
        allowed: winner.effect === "allow",
        reason: `rule:${targetStr}:${winner.effect}${tail}`,
      }
    }
  }

  // 4. Catalog defaults.
  const fallback = evaluateCatalogDefaults(model)
  return { allowed: fallback.allowed, reason: fallback.reason }
}

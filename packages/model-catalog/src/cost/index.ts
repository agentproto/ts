/**
 * Cost dispatcher — computes credit cost + production USD cost for any
 * model id, regardless of kind. Single entry point used by orchestrator,
 * billing audits, and (eventually) the metered MCP gen layer.
 *
 * Per-kind formulas:
 *   - LLM   → reuses `calculateLLMCreditCost` (token math + cache + markup)
 *   - Image → `creditCost × numOutputs`
 *   - Video → `creditCost × multipliers[resolution|duration|mode]`
 *   - Audio → `creditCost × (characters or seconds)` per `billingUnit`
 */

import {
  calculateLLMCreditCost,
  type LLMCreditCostResult,
} from "../llm/index.js"
import { getModel, getStaticModelProvider } from "../registry/index.js"
import { computeCenticredits, pricingRegistry } from "../pricing/index.js"

/**
 * Voice metadata → default audio model the dispatcher bills through.
 *
 * Voices are render-targets, not priced units. A MiniMax voice can be
 * played through `minimax/speech-02-hd` OR `…-turbo`; an ElevenLabs
 * voice through any of their model tiers. We default to the cheapest
 * model per provider so a drive-by voice-id call doesn't over-bill.
 * Callers wanting HD / premium-tier pricing should pass the audio
 * model id directly with the voice as metadata — see
 * `text-to-speech.tool.ts` for the canonical pattern.
 *
 * Add a new provider here when a new voice catalog lands (e.g.
 * `ELEVENLABS_VOICES` if/when we surface their voice IDs).
 */
const VOICE_PROVIDER_DEFAULT_MODEL: Record<string, string> = {
  minimax: "minimax/speech-02-turbo",
  elevenlabs: "elevenlabs/flash-v2.5",
}

export type CostUsage =
  | {
      kind: "llm"
      inputTokens: number
      outputTokens: number
      cacheReadInputTokens?: number
      cacheCreationInputTokens?: number
    }
  | { kind: "image"; numOutputs?: number }
  | {
      kind: "video"
      resolution?: string
      duration?: number
      mode?: string
    }
  | { kind: "audio"; characters?: number; seconds?: number }

export interface CostResult {
  kind: "llm" | "image" | "video" | "audio"
  modelId: string
  /** Canonical model id after alias resolution (LLM only; same as modelId for media) */
  canonicalId: string
  /**
   * Total **centicredits** to charge (1 displayed credit = 100 cc).
   * Honors per-model overrides. Feed straight into the ledger — the
   * `credit_transactions.credits` column stores cc, so no `× 100`
   * conversion at the call site. Format for display with
   * `displayCredits(cc) → cr`.
   */
  credits: number
  /**
   * Centicredits the pure formula (provider cost × category markup)
   * would have charged, independent of any per-model override. Equal
   * to `credits` when no override is in play. Surfaced so
   * reconciliation can diff "what we did" vs "what the formula said"
   * without recomputing — persisted to `usage_events.calculated_credits`.
   */
  calculatedCredits: number
  /** Production cost in USD (provider-side, before markup) */
  baseCostUsd: number
  /** Per-kind breakdown — inputCredits/outputCredits for LLM, etc. All in cc. */
  breakdown: Record<string, number>
  /** True iff fallback pricing was used (currently LLM-only) */
  isFallback: boolean
  /** Markup applied (1.0 = catalog rate as-is) */
  markup: number
}

export class UnknownModelError extends Error {
  constructor(public readonly modelId: string) {
    super(`Unknown model id: "${modelId}"`)
    this.name = "UnknownModelError"
  }
}

export class CostUsageKindMismatchError extends Error {
  constructor(
    public readonly modelId: string,
    public readonly expected: string,
    public readonly got: string
  ) {
    super(
      `Model "${modelId}" is kind "${expected}", but received usage of kind "${got}"`
    )
    this.name = "CostUsageKindMismatchError"
  }
}

export interface CalculateCostOptions {
  /**
   * App that's invoking the model. Routes per-app markup overrides
   * registered via `pricingRegistry.registerApp(appId, ...)`. When
   * omitted, core defaults apply.
   */
  appId?: string
}

/**
 * Computes credit + USD cost for a model run.
 *
 * Throws `UnknownModelError` for ids not in any catalog (LLM has its own
 * fallback path inside `calculateLLMCreditCost` — this surface preserves
 * that for back-compat).
 *
 * Throws `CostUsageKindMismatchError` if `usage.kind` doesn't match the
 * resolved model's kind (data integrity guard).
 *
 * Image / video / audio credits are derived at call time via the
 * pricing registry (`provider_cost × category-markup`). LLM keeps its
 * own per-model markup table inside `calculateLLMCreditCost` —
 * collapsing that follows in W6b.
 */
export function calculateCost(
  modelId: string,
  usage: CostUsage,
  opts: CalculateCostOptions = {}
): CostResult {
  // LLM has a fallback path that returns valid pricing even for unknown
  // ids (preserves the orchestrator's existing tolerance). Other kinds
  // throw for unknowns.
  if (usage.kind === "llm") {
    const llmResult: LLMCreditCostResult = calculateLLMCreditCost(modelId, {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadInputTokens: usage.cacheReadInputTokens,
      cacheCreationInputTokens: usage.cacheCreationInputTokens,
    })
    const resolved = getModel(modelId)
    const canonicalId =
      resolved && resolved.kind === "llm" ? resolved.canonicalId : modelId
    return {
      kind: "llm",
      modelId,
      canonicalId,
      credits: llmResult.credits,
      calculatedCredits: llmResult.calculatedCredits,
      baseCostUsd: llmResult.productionCost,
      breakdown: {
        inputCredits: llmResult.inputCredits,
        outputCredits: llmResult.outputCredits,
        cacheReadCredits: llmResult.cacheReadCredits,
        cacheWriteCredits: llmResult.cacheWriteCredits,
      },
      isFallback: llmResult.isFallback,
      markup: llmResult.markup,
    }
  }

  const resolved = getModel(modelId)
  if (!resolved) throw new UnknownModelError(modelId)
  // `voice` is structurally audio for billing purposes (MiniMax voice
  // metadata billed via per-character output). Accept `audio` usage on
  // voice models so the per-kind branches below can pattern-match.
  const expectedUsageKind: CostUsage["kind"] =
    resolved.kind === "voice" ? "audio" : resolved.kind
  if (expectedUsageKind !== usage.kind) {
    // Pass `expectedUsageKind` (not `resolved.kind`) so the error message
    // accurately says "audio" rather than "voice" when a voice model is
    // billed — the caller must supply audio usage, not voice usage.
    throw new CostUsageKindMismatchError(modelId, expectedUsageKind, usage.kind)
  }

  if (resolved.kind === "image") {
    const numOutputs = Math.max(1, usage.numOutputs ?? 1)
    const baseCostUsd = resolved.def.pricing.baseCost * numOutputs
    const perOutputCredits = computeCenticredits({
      baseCostUsd: resolved.def.pricing.baseCost,
      category: "image",
      overrideCreditCost: resolved.def.pricing.overrideCreditCost,
      appId: opts.appId,
    })
    const credits = perOutputCredits * numOutputs
    // Formula-only (ignores override) — for `usage_events.calculated_credits`.
    const formulaPerOutput = computeCenticredits({
      baseCostUsd: resolved.def.pricing.baseCost,
      category: "image",
      appId: opts.appId,
    })
    const calculatedCredits = formulaPerOutput * numOutputs
    const markup = pricingRegistry.getMarkup("image", opts.appId)
    return {
      kind: "image",
      modelId,
      canonicalId: modelId,
      credits,
      calculatedCredits,
      baseCostUsd,
      breakdown: {
        perOutputCredits,
        numOutputs,
      },
      isFallback: false,
      markup,
    }
  }

  if (resolved.kind === "video") {
    if (usage.kind !== "video") {
      throw new CostUsageKindMismatchError(modelId, "video", usage.kind)
    }
    const pricing = resolved.def.pricing
    // Provider-side multipliers — re-applied to BOTH the provider cost
    // (what we pay) AND the derived credit cost (so margin holds).
    const mult = pricing.multipliers
    const resMult =
      usage.resolution && mult?.resolution
        ? (mult.resolution[usage.resolution] ?? 1.0)
        : 1.0
    const durMult =
      usage.duration && mult?.duration
        ? (mult.duration[String(usage.duration)] ?? usage.duration)
        : 1.0
    const modMult =
      usage.mode && mult?.mode ? (mult.mode[usage.mode] ?? 1.0) : 1.0
    const variantMultiplier = resMult * durMult * modMult
    const baseCostUsd = pricing.baseCost * variantMultiplier
    const perClipCredits = computeCenticredits({
      baseCostUsd: pricing.baseCost,
      category: "video",
      overrideCreditCost: pricing.overrideCreditCost,
      appId: opts.appId,
    })
    const credits = Math.ceil(perClipCredits * variantMultiplier)
    const formulaPerClip = computeCenticredits({
      baseCostUsd: pricing.baseCost,
      category: "video",
      appId: opts.appId,
    })
    const calculatedCredits = Math.ceil(formulaPerClip * variantMultiplier)
    const markup = pricingRegistry.getMarkup("video", opts.appId)
    return {
      kind: "video",
      modelId,
      canonicalId: modelId,
      credits,
      calculatedCredits,
      baseCostUsd,
      breakdown: {
        perClipCredits,
        resolutionMultiplier: resMult,
        durationMultiplier: durMult,
        modeMultiplier: modMult,
        variantMultiplier,
      },
      isFallback: false,
      markup,
    }
  }

  // Audio (and voice, delegated as audio — see expectedUsageKind above).
  if (usage.kind !== "audio") {
    throw new CostUsageKindMismatchError(modelId, "audio", usage.kind)
  }

  if (resolved.kind === "voice") {
    // Voice rows are metadata; delegate to the provider's default audio model.
    const provider = resolved.voice.provider
    const delegateModelId =
      VOICE_PROVIDER_DEFAULT_MODEL[provider] ??
      getStaticModelProvider("audio", provider)
    if (!delegateModelId) throw new UnknownModelError(modelId)
    const delegateResult = calculateCost(delegateModelId, usage, opts)
    return {
      ...delegateResult,
      modelId,
      canonicalId: delegateModelId,
    }
  }

  // resolved.kind === "audio"
  const audioPricing = resolved.def.pricing
  const billingUnit = audioPricing.billingUnit
  const quantity =
    billingUnit === "per_character"
      ? (usage.characters ?? 0) / 1000
      : (usage.seconds ?? 0)
  const baseCostUsd = audioPricing.baseCost * quantity
  const perUnitCredits = computeCenticredits({
    baseCostUsd: audioPricing.baseCost,
    category: "audio",
    overrideCreditCost: audioPricing.overrideCreditCost,
    appId: opts.appId,
  })
  const credits = Math.ceil(perUnitCredits * quantity)
  const formulaPerUnit = computeCenticredits({
    baseCostUsd: audioPricing.baseCost,
    category: "audio",
    appId: opts.appId,
  })
  const calculatedCredits = Math.ceil(formulaPerUnit * quantity)
  const markup = pricingRegistry.getMarkup("audio", opts.appId)
  return {
    kind: "audio",
    modelId,
    canonicalId: modelId,
    credits,
    calculatedCredits,
    baseCostUsd,
    breakdown: {
      perUnitCredits,
      quantity,
      billingUnit: billingUnit === "per_character" ? 1000 : 1,
    },
    isFallback: false,
    markup,
  }
}

// Thin ergonomic wrappers around `calculateCost`. Two reasons they exist:
//   1. Callers with a known kind don't want to construct the full union.
//   2. The kind/usage union is a `calculateCost` implementation detail —
//      wrapper types are narrower and easier to read at call sites.

export function calculateLLMCost(
  modelId: string,
  usage: {
    inputTokens: number
    outputTokens: number
    cacheReadInputTokens?: number
    cacheCreationInputTokens?: number
  },
  opts?: CalculateCostOptions
): CostResult {
  return calculateCost(modelId, { kind: "llm", ...usage }, opts)
}

export function calculateImageCost(
  modelId: string,
  usage: { numOutputs?: number },
  opts?: CalculateCostOptions
): CostResult {
  return calculateCost(modelId, { kind: "image", ...usage }, opts)
}

export function calculateVideoCost(
  modelId: string,
  usage: { resolution?: string; duration?: number; mode?: string },
  opts?: CalculateCostOptions
): CostResult {
  return calculateCost(modelId, { kind: "video", ...usage }, opts)
}

export function calculateAudioCost(
  modelId: string,
  usage: { characters?: number; seconds?: number },
  opts?: CalculateCostOptions
): CostResult {
  return calculateCost(modelId, { kind: "audio", ...usage }, opts)
}

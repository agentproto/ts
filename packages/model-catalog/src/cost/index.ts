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
    throw new CostUsageKindMismatchError(modelId, resolved.kind, usage.kind)
  }

  if (resolved.kind === "image") {
    const numOutputs = Math.max(
      1,
      usage.kind === "image" ? (usage.numOutputs ?? 1) : 1
    )
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
        ? (mult.duration[usage.duration] ?? 1.0)
        : 1.0
    const modMult =
      usage.mode && mult?.mode ? (mult.mode[usage.mode] ?? 1.0) : 1.0
    const variantMultiplier = resMult * durMult * modMult
    const baseCostUsd = pricing.baseCost * variantMultiplier
    const baseCredits = computeCenticredits({
      baseCostUsd: pricing.baseCost,
      category: "video",
      overrideCreditCost: pricing.overrideCreditCost,
      appId: opts.appId,
    })
    // `baseCredits` is already in cc with the registry floor applied
    // per-unit; variantMultiplier scales the per-call cost. Per-call
    // floor (1 cc) catches 0× multiplier degenerate inputs the same
    // way it does in the audio path.
    const credits = Math.max(1, Math.ceil(baseCredits * variantMultiplier))
    const formulaBaseCredits = computeCenticredits({
      baseCostUsd: pricing.baseCost,
      category: "video",
      appId: opts.appId,
    })
    const calculatedCredits = Math.max(
      1,
      Math.ceil(formulaBaseCredits * variantMultiplier)
    )
    const markup = pricingRegistry.getMarkup("video", opts.appId)
    return {
      kind: "video",
      modelId,
      canonicalId: modelId,
      credits,
      calculatedCredits,
      baseCostUsd,
      breakdown: {
        baseCredits,
        resolutionMultiplier: resMult,
        durationMultiplier: durMult,
        modeMultiplier: modMult,
      },
      isFallback: false,
      markup,
    }
  }

  // Audio MODEL — TTS or STT, billed per the provider's unit.
  // (`kind: "voice"` is voice metadata for MiniMax; not a costable
  // billing entity. Voice picker → audio model → cost dispatcher.)
  if (resolved.kind === "audio") {
    if (usage.kind !== "audio") {
      throw new CostUsageKindMismatchError(modelId, "audio", usage.kind)
    }
    const pricing = resolved.def.pricing
    let unitsConsumed = 0
    switch (pricing.billingUnit) {
      case "per_1k_chars": {
        const characters = Math.max(0, usage.characters ?? 0)
        unitsConsumed = characters / 1000
        break
      }
      case "per_minute": {
        const seconds = Math.max(0, usage.seconds ?? 0)
        // Provider billing rounds to whole minutes; mirror that so
        // user-side debit matches what we'll be invoiced.
        unitsConsumed = Math.ceil(seconds / 60)
        break
      }
      case "per_second": {
        const seconds = Math.max(0, usage.seconds ?? 0)
        unitsConsumed = seconds
        break
      }
    }
    const baseCostUsd = pricing.baseCost * unitsConsumed
    const perUnitCredits = computeCenticredits({
      baseCostUsd: pricing.baseCost,
      category: "audio",
      overrideCreditCost: pricing.overrideCreditCost,
      appId: opts.appId,
    })
    // `perUnitCredits` is per-unit cc (registry floor applied per-unit);
    // multiplying by `unitsConsumed` (chars/1000 or minutes) gives
    // total cc for the call. The per-call floor (1 cc) guards against
    // 0-unit calls (e.g. empty-string TTS) which would otherwise debit
    // nothing — keeps the anti-abuse semantic the registry floor
    // can't provide (it works on per-unit, not per-call).
    const credits = Math.max(1, Math.ceil(perUnitCredits * unitsConsumed))
    const formulaPerUnit = computeCenticredits({
      baseCostUsd: pricing.baseCost,
      category: "audio",
      appId: opts.appId,
    })
    const calculatedCredits = Math.max(
      1,
      Math.ceil(formulaPerUnit * unitsConsumed)
    )
    const markup = pricingRegistry.getMarkup("audio", opts.appId)
    return {
      kind: "audio",
      modelId,
      canonicalId: modelId,
      credits,
      calculatedCredits,
      baseCostUsd,
      breakdown: {
        characters: usage.characters ?? 0,
        seconds: usage.seconds ?? 0,
        unitsConsumed,
        perUnitCredits,
      },
      isFallback: false,
      markup,
    }
  }

  // `voice` kind (MiniMax voice metadata) — voices aren't billable on
  // their own (they're a render-target on top of a TTS model). We
  // know every voice in the catalog today is MiniMax, so route
  // through MiniMax's default TTS model for pricing. Callers who want
  // HD vs Turbo pricing should pass the audio model id directly with
  // the voice as metadata; the default keeps drive-by voice ids from
  // emitting a hardcoded placeholder.
  //
  // Recursion is bounded — the delegate target resolves to `audio`
  // kind, not `voice`, so we hit at most one recursive call.
  if (resolved.kind === "voice") {
    if (usage.kind !== "audio") {
      throw new CostUsageKindMismatchError(modelId, "audio", usage.kind)
    }
    const voiceProvider = getStaticModelProvider(resolved) ?? "minimax"
    const delegateModelId =
      VOICE_PROVIDER_DEFAULT_MODEL[voiceProvider] ??
      VOICE_PROVIDER_DEFAULT_MODEL.minimax!
    const delegateResult = calculateCost(delegateModelId, usage, opts)
    return {
      ...delegateResult,
      // Preserve the voice id as the surface modelId so usage_events
      // attribute the cost to the voice the caller asked for. Internal
      // canonicalId reflects the audio model that actually billed.
      modelId,
      canonicalId: delegateResult.canonicalId,
    }
  }

  // Exhaustiveness — unreachable.
  throw new UnknownModelError(modelId)
}

// ─── TTS / STT pricing builders ──────────────────────────────────────────
//
// Thin ergonomic wrappers around `calculateCost`. Two reasons they exist:
//
//   1. **Call sites don't need to remember the discriminator shape.** TTS
//      tools care about model + text length; STT tools care about model +
//      duration. The kind/usage union is a `calculateCost` implementation
//      detail.
//   2. **Voice routing happens automatically.** Pass a voice id and the
//      builder resolves it to the right audio model (via
//      `VOICE_PROVIDER_DEFAULT_MODEL`) without the caller needing to know
//      the mapping. Pass an audio model id directly and it bills that
//      model.
//
// Both return the full `CostResult` so callers see `calculatedCredits` +
// `baseCostUsd` for analytics and the markup that was applied.

export interface PriceTTSInput {
  /**
   * Either an audio model id (e.g. `"elevenlabs/multilingual-v2"`,
   * `"minimax/speech-02-hd"`) OR a voice id from the voice catalog
   * (e.g. a MiniMax voice). Voice ids resolve to their provider's
   * default TTS model.
   */
  modelOrVoiceId: string
  /** Character count to synthesize. */
  characters: number
  /** Optional app-scoped markup + override knobs. */
  options?: CalculateCostOptions
}

export interface PriceSTTInput {
  /** Audio model id, e.g. `"deepgram/nova-3"`, `"openai/whisper-1"`. */
  modelId: string
  /** Duration to transcribe, in seconds. Billing rounds up per-minute. */
  seconds: number
  options?: CalculateCostOptions
}

/**
 * Price a TTS call. Pure compute — no I/O, safe to call pre-charge
 * (UI hints, token-budget reasoning) or at consume time.
 */
export function priceTTS(input: PriceTTSInput): CostResult {
  return calculateCost(
    input.modelOrVoiceId,
    { kind: "audio", characters: Math.max(0, input.characters) },
    input.options
  )
}

/**
 * Price an STT call. Pure compute. `seconds` rounds up to the
 * provider's billing unit (per-minute for most, per-second for some).
 */
export function priceSTT(input: PriceSTTInput): CostResult {
  return calculateCost(
    input.modelId,
    { kind: "audio", seconds: Math.max(0, input.seconds) },
    input.options
  )
}

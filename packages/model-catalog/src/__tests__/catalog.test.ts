/**
 * @agentproto/model-catalog — core unit tests
 *
 * Coverage targets (per review):
 *   1. evaluateAccess — all 4 resolution layers (app-scope, explicit model
 *      rule, band rules, catalog defaults)
 *   2. calculateCost — LLM pass-through, image/video/audio dispatch,
 *      UnknownModelError, CostUsageKindMismatchError
 *   3. registerCatalogOverlay + getModel — overlay wins over core, alias
 *      chaining, cycle guard
 *   4. shouldDebit — all 3 branches of the truth table
 *
 * No real network, no clocks, no I/O. Pure in-memory function calls only.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { evaluateAccess } from "../access/evaluate.js"
import type { AccessEvalInput } from "../access/evaluate.js"
import type { AccessRule } from "../access/types.js"
import {
  calculateCost,
  UnknownModelError,
  CostUsageKindMismatchError,
} from "../cost/index.js"
import { pricingRegistry } from "../pricing/index.js"
import {
  registerCatalogOverlay,
  clearCatalogOverlays,
} from "../overlay/index.js"
import { getModel } from "../registry/index.js"
import { shouldDebit } from "../byok/index.js"
import type { ResolvedModel } from "../registry/index.js"
import {
  resolvePricing,
  resolveModelRoute,
  resolveContextWindow,
  listNativeModelIds,
  splitContextWindowHint,
  resolvePricingExact,
  resolveAlias,
  isKnownLlmId,
  listUnpricedKnownLlmIds,
  LLM_PRICING_CATALOG,
} from "../llm/catalog.js"
import { DEFAULT_ANTHROPIC_MODEL } from "../llm/defaults.js"
import {
  OPENAI_GENERATED_PRICING,
  OPENAI_GENERATED_UNPRICED_IDS,
} from "../llm/openai-pricing.generated.js"
import { MOONSHOT_GENERATED_PRICING } from "../llm/moonshot-pricing.generated.js"
import { ANTHROPIC_GENERATED_PRICING } from "../llm/anthropic-pricing.generated.js"
import { XAI_GENERATED_PRICING } from "../llm/xai-pricing.generated.js"
import { CONTEXT_WINDOWS } from "../llm/context-windows.generated.js"
import { OPENROUTER_ROUTES } from "../llm/openrouter-routes.generated.js"
import { PROVIDER_KEY_ENV } from "../schema/base.js"
import { ANTHROPIC_GATEWAY_PRESETS } from "@agentproto/provider-presets"

// ─── data-independent subjects ────────────────────────────────────────────
// The generated tables are rewritten by every catalog sync, so tests never
// name a specific model/price from them: they pick subjects from the tables
// as they are and assert behaviour against the row they picked. (The few
// intentionally data-dependent checks live in *.drift.test.ts.)
const pickIds = (ids: string[], n: number): string[] => {
  const picked = ids.filter(id => resolvePricingExact(id) !== undefined).slice(0, n)
  if (picked.length < n) throw new Error(`generated tables expose fewer than ${n} priced ids`)
  return picked
}
const [KNOWN_ANTHROPIC, KNOWN_ANTHROPIC_2] = pickIds(
  Object.keys(ANTHROPIC_GENERATED_PRICING).filter(id => !id.includes(".")),
  2
) as [string, string]
const [KNOWN_OPENAI] = pickIds(
  Object.keys(OPENAI_GENERATED_PRICING).filter(id => !id.includes(":") && !id.includes("/")),
  1
) as [string]

// ─── helpers ──────────────────────────────────────────────────────────────

/** Minimal stable LLM ResolvedModel for evaluator tests. */
function llmModel(id = "claude-sonnet-4-5"): ResolvedModel {
  return {
    kind: "llm",
    id,
    canonicalId: id,
    pricing: { inputPer1M: 3.0, outputPer1M: 15.0, provider: "anthropic", vendor: "anthropic" },
    provider: "anthropic",
  }
}

/** Minimal stable image ResolvedModel for evaluator tests. */
function imageModel(id = "nano-banana", agentVisible = true): ResolvedModel {
  return {
    kind: "image",
    id,
    def: {
      id,
      name: "Nano Banana",
      providerId: "google/nano-banana",
      provider: "replicate",
      capabilities: { generate: true, edit: true },
      referenceImages: { supported: false, fieldName: "none", maxCount: 0, singular: false },
      aspectRatio: { supported: ["1:1"], default: "1:1" },
      output: "string",
      pricing: { costPerImage: 0.04, costTier: "low", billingUnit: "per_image", baseCost: 0.04 },
      description: "test",
      agentVisible,
    },
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. evaluateAccess — all 4 resolution layers
// ═══════════════════════════════════════════════════════════════════════════

describe("evaluateAccess", () => {
  // ── Layer 1: App scope ──────────────────────────────────────────────────

  describe("layer 1 — app scope", () => {
    it("blocks a model whose kind is absent from app scope", () => {
      const input: AccessEvalInput = {
        model: llmModel(),
        appScope: { kinds: ["image"] },
      }
      const decision = evaluateAccess(input)
      expect(decision.allowed).toBe(false)
      expect(decision.reason).toContain("app-scope")
    })

    it("allows a model whose kind is in app scope", () => {
      const input: AccessEvalInput = {
        model: imageModel(),
        appScope: { kinds: ["image"] },
      }
      const decision = evaluateAccess(input)
      // Falls through to catalog defaults (agentVisible=true → allow)
      expect(decision.allowed).toBe(true)
    })

    it("allows everything when app scope kinds is empty (no restriction)", () => {
      const input: AccessEvalInput = {
        model: llmModel(),
        appScope: { kinds: [] },
      }
      const decision = evaluateAccess(input)
      expect(decision.allowed).toBe(true)
    })

    it("voice models bypass app-scope kind check", () => {
      const voiceModel: ResolvedModel = {
        kind: "voice",
        id: "minimax-french-female-anchor",
        voice: {
          catalogId: "minimax-french-female-anchor",
          providerVoiceId: "French_FemaleAnchor",
          provider: "minimax",
          label: "French Female Anchor",
          description: "French female anchor voice",
          gender: "female",
          primaryLanguage: "fr",
          supportedLanguages: ["fr"],
        },
      }
      const input: AccessEvalInput = {
        model: voiceModel,
        // Only image allowed — voice should not be blocked by kind scope
        appScope: { kinds: ["image"] },
      }
      const decision = evaluateAccess(input)
      // Falls through to catalog defaults (voice-curated → allow)
      expect(decision.allowed).toBe(true)
    })
  })

  // ── Layer 2: Explicit per-model rules ──────────────────────────────────

  describe("layer 2 — explicit model rules", () => {
    it("allows when an explicit model:allow rule matches", () => {
      const rules: AccessRule[] = [
        { effect: "allow", target: { kind: "model", id: "claude-sonnet-4-5" } },
      ]
      const decision = evaluateAccess({ model: llmModel(), rules })
      expect(decision.allowed).toBe(true)
      expect(decision.reason).toContain("rule:model")
    })

    it("blocks when an explicit model:block rule matches", () => {
      const rules: AccessRule[] = [
        { effect: "block", target: { kind: "model", id: "claude-sonnet-4-5" }, reason: "nsfw" },
      ]
      const decision = evaluateAccess({ model: llmModel(), rules })
      expect(decision.allowed).toBe(false)
      expect(decision.reason).toContain("nsfw")
    })

    it("block beats allow within the model band", () => {
      const rules: AccessRule[] = [
        { effect: "allow", target: { kind: "model", id: "claude-sonnet-4-5" } },
        { effect: "block", target: { kind: "model", id: "claude-sonnet-4-5" } },
      ]
      const decision = evaluateAccess({ model: llmModel(), rules })
      expect(decision.allowed).toBe(false)
    })

    it("non-matching model rule is ignored", () => {
      const rules: AccessRule[] = [
        { effect: "block", target: { kind: "model", id: "gpt-4o" } },
      ]
      const decision = evaluateAccess({ model: llmModel("claude-sonnet-4-5"), rules })
      // Falls through to catalog defaults (LLM curated → allow)
      expect(decision.allowed).toBe(true)
    })
  })

  // ── Layer 3: Band rules (tag / provider / priceTier / kind) ───────────

  describe("layer 3 — band rules", () => {
    it("kind:llm block denies all LLMs", () => {
      const rules: AccessRule[] = [
        { effect: "block", target: { kind: "kind", value: "llm" } },
      ]
      const decision = evaluateAccess({ model: llmModel(), rules })
      expect(decision.allowed).toBe(false)
    })

    it("kind:image allow permits an image model", () => {
      const rules: AccessRule[] = [
        { effect: "allow", target: { kind: "kind", value: "image" } },
      ]
      const decision = evaluateAccess({ model: imageModel(), rules })
      expect(decision.allowed).toBe(true)
    })

    it("tag:anthropic block denies an anthropic-tagged LLM", () => {
      const rules: AccessRule[] = [
        { effect: "block", target: { kind: "tag", value: "anthropic" } },
      ]
      // claude-sonnet-4-5 has tag "anthropic" via explicit enrichment
      const decision = evaluateAccess({ model: llmModel("claude-sonnet-4-5"), rules })
      expect(decision.allowed).toBe(false)
    })

    it("tag (specificity 4) beats kind (specificity 1) — tag allow overrides kind block", () => {
      const rules: AccessRule[] = [
        { effect: "block", target: { kind: "kind", value: "llm" } },
        { effect: "allow", target: { kind: "tag", value: "anthropic" } },
      ]
      // claude-sonnet-4-5 carries the "anthropic" tag → tag band (4) beats kind band (1)
      const decision = evaluateAccess({ model: llmModel("claude-sonnet-4-5"), rules })
      expect(decision.allowed).toBe(true)
      expect(decision.reason).toContain("tag:anthropic")
    })

    it("BYOK relaxation skips priceTier:premium blocks (non-NSFW)", () => {
      const rules: AccessRule[] = [
        { effect: "block", target: { kind: "priceTier", value: "premium" } },
      ]
      // claude-opus-4-5 is priceTier:premium; with byokActive the block is skipped
      const premiumModel = llmModel("claude-opus-4-5")
      const blocked = evaluateAccess({ model: premiumModel, rules, byokActive: false })
      expect(blocked.allowed).toBe(false)

      const bypassed = evaluateAccess({ model: premiumModel, rules, byokActive: true })
      // Falls through to catalog defaults (LLM curated → allow)
      expect(bypassed.allowed).toBe(true)
    })

    it("BYOK relaxation does NOT bypass priceTier:premium block flagged nsfw", () => {
      const rules: AccessRule[] = [
        { effect: "block", target: { kind: "priceTier", value: "premium" }, reason: "nsfw" },
      ]
      const premiumModel = llmModel("claude-opus-4-5")
      const decision = evaluateAccess({ model: premiumModel, rules, byokActive: true })
      expect(decision.allowed).toBe(false)
    })

    it("block wins within same band", () => {
      const rules: AccessRule[] = [
        { effect: "allow", target: { kind: "kind", value: "llm" } },
        { effect: "block", target: { kind: "kind", value: "llm" } },
      ]
      const decision = evaluateAccess({ model: llmModel(), rules })
      expect(decision.allowed).toBe(false)
    })
  })

  // ── Layer 4: Catalog defaults ──────────────────────────────────────────

  describe("layer 4 — catalog defaults", () => {
    it("LLM models default to allowed (curated)", () => {
      const decision = evaluateAccess({ model: llmModel() })
      expect(decision.allowed).toBe(true)
      expect(decision.reason).toBe("catalog-default:llm-curated")
    })

    it("agent-visible image model defaults to allowed", () => {
      const decision = evaluateAccess({ model: imageModel("flux-2-dev", true) })
      expect(decision.allowed).toBe(true)
      expect(decision.reason).toBe("catalog-default:agent-visible")
    })

    it("agent-hidden image model defaults to blocked", () => {
      const decision = evaluateAccess({ model: imageModel("hidden-model", false) })
      expect(decision.allowed).toBe(false)
      expect(decision.reason).toBe("catalog-default:agent-hidden")
    })

    it("voice metadata defaults to allowed (curated)", () => {
      const voiceModel: ResolvedModel = {
        kind: "voice",
        id: "test-voice",
        voice: {
          catalogId: "test-voice",
          providerVoiceId: "TestVoice",
          provider: "minimax",
          label: "Test Voice",
          description: "Test voice",
          gender: "female",
          primaryLanguage: "en",
          supportedLanguages: ["en"],
        },
      }
      const decision = evaluateAccess({ model: voiceModel })
      expect(decision.allowed).toBe(true)
      expect(decision.reason).toBe("catalog-default:voice-curated")
    })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 2. calculateCost — dispatcher, errors
// ═══════════════════════════════════════════════════════════════════════════

describe("calculateCost", () => {
  // Reset the pricing registry after each test to prevent cross-test contamination
  afterEach(() => {
    pricingRegistry.reset()
  })

  // ── LLM pass-through ───────────────────────────────────────────────────

  describe("LLM pass-through", () => {
    it("returns kind:llm with positive credits for a known model", () => {
      const result = calculateCost(KNOWN_ANTHROPIC, {
        kind: "llm",
        inputTokens: 1_000,
        outputTokens: 500,
      })
      expect(result.kind).toBe("llm")
      expect(result.modelId).toBe(KNOWN_ANTHROPIC)
      expect(result.credits).toBeGreaterThan(0)
      expect(result.calculatedCredits).toBeGreaterThan(0)
      expect(result.baseCostUsd).toBeGreaterThan(0)
      expect(typeof result.markup).toBe("number")
    })

    it("returns a CostResult with LLM breakdown keys", () => {
      const result = calculateCost(KNOWN_OPENAI, {
        kind: "llm",
        inputTokens: 2_000,
        outputTokens: 1_000,
      })
      expect(result.breakdown).toHaveProperty("inputCredits")
      expect(result.breakdown).toHaveProperty("outputCredits")
      expect(result.breakdown).toHaveProperty("cacheReadCredits")
      expect(result.breakdown).toHaveProperty("cacheWriteCredits")
    })

    it("does NOT throw UnknownModelError for unknown LLM ids (fallback path)", () => {
      // LLM dispatcher has its own fallback pricing for unknown ids
      expect(() =>
        calculateCost("nonexistent-llm-model", { kind: "llm", inputTokens: 1, outputTokens: 1 })
      ).not.toThrow()
    })

    it("cache tokens increase cost appropriately", () => {
      const base = calculateCost(KNOWN_ANTHROPIC, {
        kind: "llm",
        inputTokens: 1_000,
        outputTokens: 500,
      })
      const withCache = calculateCost(KNOWN_ANTHROPIC, {
        kind: "llm",
        inputTokens: 1_000,
        outputTokens: 500,
        cacheCreationInputTokens: 5_000,
      })
      // Cache write surcharge (1.25× input rate) adds to the total
      expect(withCache.credits).toBeGreaterThan(base.credits)
    })
  })

  // ── Image dispatch ─────────────────────────────────────────────────────

  describe("image dispatch", () => {
    it("returns kind:image with positive credits for a known image model", () => {
      const result = calculateCost("nano-banana", { kind: "image" })
      expect(result.kind).toBe("image")
      expect(result.modelId).toBe("nano-banana")
      expect(result.credits).toBeGreaterThan(0)
      expect(result.breakdown).toHaveProperty("numOutputs")
      expect(result.breakdown.numOutputs).toBe(1)
    })

    it("scales credits linearly with numOutputs", () => {
      const one = calculateCost("nano-banana", { kind: "image", numOutputs: 1 })
      const three = calculateCost("nano-banana", { kind: "image", numOutputs: 3 })
      expect(three.credits).toBe(one.credits * 3)
      expect(three.baseCostUsd).toBeCloseTo(one.baseCostUsd * 3)
    })

    it("treats numOutputs=0 as 1 (floor guard)", () => {
      const zero = calculateCost("nano-banana", { kind: "image", numOutputs: 0 })
      const one = calculateCost("nano-banana", { kind: "image", numOutputs: 1 })
      expect(zero.credits).toBe(one.credits)
    })

    it("throws CostUsageKindMismatchError when usage.kind does not match model", () => {
      expect(() =>
        // nano-banana is an image model; supplying llm usage
        calculateCost("nano-banana", { kind: "llm", inputTokens: 1, outputTokens: 1 })
      ).not.toThrow() // LLM path runs first regardless — model kind not checked for llm usage

      // Supply audio usage for an image model → kind mismatch
      expect(() =>
        calculateCost("nano-banana", { kind: "audio" })
      ).toThrow(CostUsageKindMismatchError)
    })
  })

  // ── Video dispatch ─────────────────────────────────────────────────────

  describe("video dispatch", () => {
    it("returns kind:video with positive credits for a known video model", () => {
      // Use a known video model from the catalog
      const result = calculateCost("google/veo-3.1", { kind: "video" })
      expect(result.kind).toBe("video")
      expect(result.credits).toBeGreaterThan(0)
    })

    it("throws CostUsageKindMismatchError for wrong usage kind on video model", () => {
      expect(() =>
        calculateCost("google/veo-3.1", { kind: "audio" })
      ).toThrow(CostUsageKindMismatchError)
    })
  })

  // ── Audio dispatch ─────────────────────────────────────────────────────

  describe("audio dispatch", () => {
    it("returns kind:audio with positive credits for a known audio model (TTS)", () => {
      const result = calculateCost("elevenlabs/multilingual-v2", {
        kind: "audio",
        characters: 1_000,
      })
      expect(result.kind).toBe("audio")
      expect(result.credits).toBeGreaterThan(0)
    })

    it("returns kind:audio for a per_minute STT model fed seconds", () => {
      const result = calculateCost("google/gemini-live", {
        kind: "audio",
        seconds: 60,
      })
      expect(result.kind).toBe("audio")
      expect(result.credits).toBeGreaterThan(0)
    })

    it("throws CostUsageKindMismatchError for wrong usage kind on audio model", () => {
      expect(() =>
        calculateCost("elevenlabs/multilingual-v2", { kind: "image" })
      ).toThrow(CostUsageKindMismatchError)
    })
  })

  // ── Error cases ────────────────────────────────────────────────────────

  describe("error cases", () => {
    it("throws UnknownModelError for a completely unknown non-LLM model id", () => {
      expect(() =>
        calculateCost("unknown-image-xyz-abc", { kind: "image" })
      ).toThrow(UnknownModelError)
    })

    it("CostUsageKindMismatchError carries correct modelId / expected / got", () => {
      let err: CostUsageKindMismatchError | undefined
      try {
        calculateCost("nano-banana", { kind: "audio" })
      } catch (e) {
        if (e instanceof CostUsageKindMismatchError) err = e
      }
      expect(err).toBeDefined()
      expect(err!.modelId).toBe("nano-banana")
      expect(err!.expected).toBe("image") // model kind
      expect(err!.got).toBe("audio")
    })

    it("CostUsageKindMismatchError for voice model says expected='audio' not 'voice'", () => {
      // Voice models are billed as audio — mismatch error should say "audio"
      // This is a regression guard for Finding #4 in the review.
      const voiceId = "minimax-french-female-anchor"
      const resolved = getModel(voiceId)
      // Only run this assertion if the voice is in the catalog; skip otherwise
      if (resolved?.kind !== "voice") return

      let err: CostUsageKindMismatchError | undefined
      try {
        calculateCost(voiceId, { kind: "image" })
      } catch (e) {
        if (e instanceof CostUsageKindMismatchError) err = e
      }
      expect(err).toBeDefined()
      // The key regression: `expected` must be "audio", NOT "voice"
      expect(err!.expected).toBe("audio")
      expect(err!.got).toBe("image")
    })
  })

  // ── Per-app markup override ────────────────────────────────────────────

  describe("app-scoped markup (pricingRegistry.reset isolation)", () => {
    it("app override increases credits above default", () => {
      const defaultResult = calculateCost("nano-banana", { kind: "image" })

      pricingRegistry.registerApp("test-app", {
        markup: { image: 3.0 }, // 2× the default 1.5
        floor: {},
      })
      const appResult = calculateCost("nano-banana", { kind: "image" }, { appId: "test-app" })
      expect(appResult.credits).toBeGreaterThan(defaultResult.credits)
    })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 3. registerCatalogOverlay + getModel — overlay, alias, cycle guard
// ═══════════════════════════════════════════════════════════════════════════

describe("registerCatalogOverlay + getModel", () => {
  // Always clean up overlays after each test
  afterEach(() => {
    clearCatalogOverlays()
  })

  it("overlay image entry wins over core catalog for the same id", () => {
    const customDef = {
      id: "nano-banana",
      name: "Custom Banana",
      providerId: "custom/nano-banana",
      provider: "replicate" as const,
      capabilities: { generate: true, edit: false },
      referenceImages: { supported: false, fieldName: "none" as const, maxCount: 0, singular: false },
      aspectRatio: { supported: ["1:1"], default: "1:1" },
      output: "string" as const,
      pricing: { costPerImage: 99.0, costTier: "high" as const, billingUnit: "per_image" as const, baseCost: 99.0 },
      description: "custom overlay model",
      agentVisible: true,
    }
    registerCatalogOverlay({ image: { "nano-banana": customDef } })

    const resolved = getModel("nano-banana")
    expect(resolved?.kind).toBe("image")
    if (resolved?.kind === "image") {
      expect(resolved.def.pricing.baseCost).toBe(99.0)
      expect(resolved.def.name).toBe("Custom Banana")
    }
  })

  it("overlay alias resolves to a real catalog id", () => {
    registerCatalogOverlay({
      aliases: { "my-sonnet-alias": KNOWN_ANTHROPIC },
    })
    const resolved = getModel("my-sonnet-alias")
    expect(resolved).toBeDefined()
    expect(resolved?.kind).toBe("llm")
    // The returned id is alias-preserving
    expect(resolved?.id).toBe("my-sonnet-alias")
  })

  it("alias chain collapses (multi-hop)", () => {
    registerCatalogOverlay({
      aliases: {
        "step-1": "step-2",
        "step-2": KNOWN_ANTHROPIC_2,
      },
    })
    const resolved = getModel("step-1")
    expect(resolved?.kind).toBe("llm")
  })

  it("cycle in alias chain does NOT hang (cycle guard)", () => {
    // step-a → step-b → step-a forms a cycle; should not infinite-loop
    registerCatalogOverlay({
      aliases: {
        "cycle-a": "cycle-b",
        "cycle-b": "cycle-a",
      },
    })
    // Should return undefined (no real catalog entry) rather than hanging
    expect(() => getModel("cycle-a")).not.toThrow()
  })

  it("clearCatalogOverlays removes all registered overlays", () => {
    registerCatalogOverlay({
      aliases: { "alias-to-clear": KNOWN_ANTHROPIC },
    })
    expect(getModel("alias-to-clear")).toBeDefined()

    clearCatalogOverlays()

    expect(getModel("alias-to-clear")).toBeUndefined()
  })

  it("later overlay registration overrides earlier one for the same key", () => {
    registerCatalogOverlay({
      aliases: { "my-alias": KNOWN_ANTHROPIC_2 },
    })
    registerCatalogOverlay({
      aliases: { "my-alias": KNOWN_ANTHROPIC },
    })
    const resolved = getModel("my-alias")
    expect(resolved?.kind).toBe("llm")
    if (resolved?.kind === "llm") {
      // Should resolve to sonnet (the later registration)
      expect(resolved.canonicalId).toBe(KNOWN_ANTHROPIC)
    }
  })

  it("overlay LLM entry is returned by getModel", () => {
    registerCatalogOverlay({
      llm: {
        "my-finetune": {
          inputPer1M: 1.0,
          outputPer1M: 5.0,
          provider: "openai",
          vendor: "custom",
        },
      },
    })
    const resolved = getModel("my-finetune")
    expect(resolved?.kind).toBe("llm")
    if (resolved?.kind === "llm") {
      expect(resolved.pricing?.inputPer1M).toBe(1.0)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 4. shouldDebit — all 3 branches of the truth table
// ═══════════════════════════════════════════════════════════════════════════

describe("shouldDebit", () => {
  it("byokActive=true + hasConnector=true → debit:false, shadow:true (reason: byok-active-with-connector)", () => {
    const result = shouldDebit({ modelId: "any", byokActive: true, hasConnector: true })
    expect(result.debit).toBe(false)
    expect(result.shadow).toBe(true)
    expect(result.reason).toBe("byok-active-with-connector")
  })

  it("byokActive=true + hasConnector=false → debit:true, shadow:false (reason: byok-flag-but-no-connector)", () => {
    const result = shouldDebit({ modelId: "any", byokActive: true, hasConnector: false })
    expect(result.debit).toBe(true)
    expect(result.shadow).toBe(false)
    expect(result.reason).toBe("byok-flag-but-no-connector")
  })

  it("byokActive=false + hasConnector=true → debit:true, shadow:false (reason: non-byok)", () => {
    const result = shouldDebit({ modelId: "any", byokActive: false, hasConnector: true })
    expect(result.debit).toBe(true)
    expect(result.shadow).toBe(false)
    expect(result.reason).toBe("non-byok")
  })

  it("byokActive=false + hasConnector=false → debit:true, shadow:false (reason: non-byok)", () => {
    const result = shouldDebit({ modelId: "any", byokActive: false, hasConnector: false })
    expect(result.debit).toBe(true)
    expect(result.shadow).toBe(false)
    expect(result.reason).toBe("non-byok")
  })
})

describe("PROVIDER_KEY_ENV", () => {
  it("huggingface reads HF_TOKEN, not HUGGINGFACE_API_KEY (regression)", () => {
    // opencode's bundled huggingface provider only reads HF_TOKEN; the old
    // HUGGINGFACE_API_KEY value left the model-derived-api-key path injecting
    // a credential no consumer reads. See schema/base.ts's PROVIDER_KEY_ENV
    // comment for the full story.
    expect(PROVIDER_KEY_ENV.huggingface).toBe("HF_TOKEN")
  })

  it("stays in sync with ANTHROPIC_GATEWAY_PRESETS.keyEnv for every provider present in both maps", () => {
    // PROVIDER_KEY_ENV (model-catalog) and ANTHROPIC_GATEWAY_PRESETS
    // (provider-presets) are two independent source-of-truth maps for the
    // same fact — which env var carries a provider's key. They cover
    // different provider sets (gateway presets include non-catalog gateways
    // like moonshot/deepseek/groq; PROVIDER_KEY_ENV covers every catalog
    // provider including non-gateway ones like anthropic/replicate), so this
    // only cross-checks the overlap rather than requiring full parity.
    const providers = Object.keys(PROVIDER_KEY_ENV) as (keyof typeof PROVIDER_KEY_ENV)[]
    const checked: string[] = []
    for (const provider of providers) {
      const preset = (ANTHROPIC_GATEWAY_PRESETS as Record<string, { keyEnv?: string }>)[provider]
      if (!preset?.keyEnv) continue
      checked.push(provider)
      expect(PROVIDER_KEY_ENV[provider]).toBe(preset.keyEnv)
    }
    // Sanity: the overlap check actually exercised at least one provider
    // (huggingface), so a refactor that empties both maps can't pass silently.
    expect(checked).toContain("huggingface")
  })
})

describe("LLM_PRICING_CATALOG — latest Anthropic ids", () => {
  // These ids are advertised by the claude-code / claude-sdk adapters; they
  // must resolve to a concrete anthropic-priced route so `agentproto models`
  // reports a price and marks them runnable.
  // Subjects come from ANTHROPIC_GENERATED_PRICING itself: generated wins on
  // divergence (catalog.ts's LLM_PRICING_CATALOG comment), so whatever row the
  // table carries must surface unmangled through resolvePricing.
  it.each(
    Object.entries(ANTHROPIC_GENERATED_PRICING)
      .filter(([id]) => !id.includes("."))
      .slice(0, 3)
  )("%s resolves to anthropic pricing", (id, row) => {
    const pricing = resolvePricing(id)
    expect(pricing).toBeDefined()
    expect(pricing?.provider).toBe("anthropic")
    expect(pricing?.vendor).toBe("anthropic")
    expect(pricing?.inputPer1M).toBe(row.inputPer1M)
    expect(pricing?.outputPer1M).toBe(row.outputPer1M)

    const route = resolveModelRoute(id)
    expect(route?.provider).toBe("anthropic")
  })
})

describe("LLM_PRICING_CATALOG — Moonshot (Kimi)", () => {
  // Both ids are priced by MOONSHOT_GENERATED_PRICING — generated wins on
  // divergence, see catalog.ts's LLM_PRICING_CATALOG comment. Asserted
  // against that generated row rather than a hardcoded literal: OpenRouter's
  // live Moonshot price moves by a few cents/rounding on basically every
  // sync (it broke this exact hardcoded pin twice: 0.95/4.0 -> 0.66/3.4 ->
  // 0.6562/3.3), so a literal here is a red-CI generator, not a real
  // regression check. What actually matters — that resolvePricing surfaces
  // the generated row unmangled, rather than a stale hand-typed override or
  // an off-by-something — still holds without pinning a number that catalog
  // drift is *expected* to change.
  it.each(Object.keys(MOONSHOT_GENERATED_PRICING).slice(0, 2))(
    "%s resolves to its MOONSHOT_GENERATED_PRICING row exactly",
    id => {
      const generated = MOONSHOT_GENERATED_PRICING[id as keyof typeof MOONSHOT_GENERATED_PRICING]
      expect(generated, id).toBeDefined()
      const pricing = resolvePricing(id)
      expect(pricing).toBeDefined()
      expect(pricing?.vendor).toBe("moonshot")
      expect(pricing?.provider).toBe("moonshot")
      expect(pricing?.inputPer1M).toBe(generated.inputPer1M)
      expect(pricing?.outputPer1M).toBe(generated.outputPer1M)
    }
  )

  // OpenRouter-routed ids resolve to their own literal OPENROUTER_ROUTES
  // entry (vendor as OpenRouter reports it) BEFORE the alias table is even
  // consulted — resolvePricing tries a direct match first. Different vendor
  // string than the direct-SDK entries above by design.
  //
  // Prices are OpenRouter's LIVE numbers, re-synced weekly, so they are
  // compared with the OPENROUTER_ROUTES row rather than pinned: drift in the
  // number is expected; what must hold is that the vendor/provider tagging
  // survives and the row surfaces unmangled.
  it.each(
    Object.keys(OPENROUTER_ROUTES)
      .filter(id => id.startsWith("moonshotai/"))
      .slice(0, 2)
  )("%s resolves to its OpenRouter-routed pricing row", id => {
    const pricing = resolvePricing(id)
    expect(pricing).toBeDefined()
    expect(pricing?.vendor).toBe("moonshotai")
    expect(pricing?.provider).toBe("openrouter")
    expect(pricing?.inputPer1M).toBe(OPENROUTER_ROUTES[id]!.inputPer1M)
    expect(pricing?.outputPer1M).toBe(OPENROUTER_ROUTES[id]!.outputPer1M)
  })
})

describe("resolveContextWindow", () => {
  const firstOf = (provider: string) =>
    Object.entries(CONTEXT_WINDOWS).find(([, e]) => e.provider === provider)
  it.each(["anthropic", "groq", "moonshot"])(
    "a %s id resolves to its live context window row",
    provider => {
      const found = firstOf(provider)
      expect(found, `no ${provider} row in the synced table`).toBeDefined()
      const [id, row] = found!
      const entry = resolveContextWindow(id)
      expect(entry).toBeDefined()
      expect(entry?.contextWindow).toBe(row.contextWindow)
      expect(entry?.maxOutput).toBe(row.maxOutput)
      expect(entry?.provider).toBe(provider)
    }
  )

  it("returns undefined for a non-synced provider", () => {
    expect(resolveContextWindow("gpt-4o")).toBeUndefined()
    expect(resolveContextWindow("glm-4.6")).toBeUndefined()
  })

  // claude-agent-acp guesses 200k for bare Anthropic ids until the first
  // result; the daemon seeds from this catalog instead, so every Anthropic id
  // in the table must resolve to exactly its synced window.
  it("every synced Anthropic id resolves to its table window", () => {
    const anthropic = Object.entries(CONTEXT_WINDOWS).filter(([, e]) => e.provider === "anthropic")
    expect(anthropic.length).toBeGreaterThan(0)
    for (const [id, row] of anthropic) {
      expect(resolveContextWindow(id)?.contextWindow, id).toBe(row.contextWindow)
    }
  })

  it("strips a [1m] lane hint for identity but keeps it for the window", () => {
    const id = KNOWN_ANTHROPIC
    const entry = resolveContextWindow(`${id}[1m]`)
    expect(entry?.contextWindow).toBe(1_000_000)
    expect(entry?.displayName).toBe(resolveContextWindow(id)?.displayName)
    expect(resolveContextWindow("not-a-model[1m]")).toBeUndefined()
  })
})

describe("splitContextWindowHint", () => {
  it.each([
    ["some-model-a[1m]", "some-model-a", 1_000_000],
    ["some-model-b[1M]", "some-model-b", 1_000_000],
    ["opus[1m]", "opus", 1_000_000],
    ["some-model[200k]", "some-model", 200_000],
    ["some-model[1.5m]", "some-model", 1_500_000],
  ])("%s → %s + %d", (raw, id, contextWindow) => {
    expect(splitContextWindowHint(raw)).toEqual({ id, contextWindow })
  })

  it.each(["some-model-a", "model[beta]", "[1m]", "model[1m]x"])("%s carries no hint", raw => {
    expect(splitContextWindowHint(raw)).toEqual({ id: raw })
  })

  it("pricing/alias lookups ignore the hint", () => {
    const id = KNOWN_ANTHROPIC
    expect(resolvePricing(`${id}[1m]`)).toEqual(resolvePricing(id))
    expect(resolvePricingExact(`${id}[1m]`)).toEqual(resolvePricingExact(id))
    expect(resolvePricingExact(`${id}[1m]`)).toBeDefined()
    expect(resolveAlias(`${id}[1m]`)).toBe(resolveAlias(id))
  })

  it("DEFAULT_ANTHROPIC_MODEL is a stable canonical alias target", () => {
    // That the default is still served by the synced tables is a drift check:
    // see default-model.drift.test.ts.
    expect(DEFAULT_ANTHROPIC_MODEL).toBe("claude-sonnet-5-5")
    expect(resolveAlias(DEFAULT_ANTHROPIC_MODEL)).toBe(DEFAULT_ANTHROPIC_MODEL)
  })
})

describe("listNativeModelIds", () => {
  it("includes every synced Anthropic id that has a context-window row", () => {
    // Absence of a priced id from a hand-typed list motivated deriving this
    // list from the generated tables; every id both tables know must show up.
    const listed = new Set(listNativeModelIds("anthropic"))
    const expected = Object.keys(ANTHROPIC_GENERATED_PRICING).filter(
      id => CONTEXT_WINDOWS[id]?.provider === "anthropic"
    )
    expect(expected.length).toBeGreaterThan(0)
    for (const id of expected) expect(listed.has(id), id).toBe(true)
  })

  it("includes every synced xAI id that has a context-window row", () => {
    const listed = new Set(listNativeModelIds("xai"))
    const expected = Object.keys(XAI_GENERATED_PRICING).filter(
      id => CONTEXT_WINDOWS[id]?.provider === "xai"
    )
    expect(expected.length).toBeGreaterThan(0)
    for (const id of expected) expect(listed.has(id), id).toBe(true)
  })

  it("returns only ids native to the requested provider, never an OpenRouter-routed form", () => {
    const anthropicIds = listNativeModelIds("anthropic")
    expect(anthropicIds.length).toBeGreaterThan(0)
    for (const id of anthropicIds) {
      // OpenRouter/requesty routes are provider-prefixed ("anthropic/claude-opus-4-6"),
      // never a bare native id — reject that shape outright.
      expect(id).not.toContain("/")
      expect(resolveContextWindow(id)?.provider).toBe("anthropic")
    }

    const xaiIds = listNativeModelIds("xai")
    expect(xaiIds.length).toBeGreaterThan(0)
    for (const id of xaiIds) {
      expect(id).not.toContain("/")
      expect(resolveContextWindow(id)?.provider).toBe("xai")
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 10. OpenAI native catalog source — ids from OpenAI, prices official-first
// ═══════════════════════════════════════════════════════════════════════════

describe("OPENAI_GENERATED_PRICING — native id + official price source", () => {
  // Whether a row's provenance actually lands on "openai" or falls back to
  // "openrouter" depends on OPENAI_API_KEY (and OpenAI's docs page) being
  // reachable to the catalog-sync run that last regenerated this file — an
  // environment fact, not a code invariant. That behavior — id source,
  // official-vs-fallback pricing, per input fixture — is already covered
  // deterministically by packages/catalog-sync/src/__tests__/openai-catalog.test.ts
  // (mergeOpenAiCatalog, no network). Pinning a specific provenance HERE, on
  // the committed generated file, previously broke catalog-sync's own CI run
  // whenever OPENAI_API_KEY misbehaved (2026-09-27, runs 36288220170 and
  // 36339321574) even though nothing was wrong with the code. What this
  // suite checks is what must hold in either provenance state.
  it("prices the flagship ids, tagged with a valid provenance", () => {
    for (const id of Object.keys(OPENAI_GENERATED_PRICING).filter(k => !k.includes(":")).slice(0, 5)) {
      const pricing = resolvePricing(id)
      expect(pricing?.provider, id).toBe("openai")
      expect(["openai", "openrouter"], id).toContain(pricing?.priceSource)
      expect(["openai", "openrouter"], id).toContain(pricing?.idSource)
    }
  })

  it("keeps OpenRouter-only ids priced and flagged, rather than dropped", () => {
    // Ids OpenAI's /v1/models cannot list (`:batch` endpoints, open-weights)
    // stay in the table flagged idSource "openrouter" and must still price.
    for (const [id, row] of Object.entries(OPENAI_GENERATED_PRICING)) {
      if ((row as { idSource: string }).idSource !== "openrouter") continue
      expect(resolvePricing(id), id).toBeDefined()
    }
  })

  it("never emits a zero price as a stand-in for an unknown one", () => {
    for (const [id, pricing] of Object.entries(OPENAI_GENERATED_PRICING)) {
      expect(pricing.inputPer1M, id).toBeGreaterThan(0)
      expect(pricing.outputPer1M, id).toBeGreaterThan(0)
    }
  })

  it("tags every row with both provenance fields", () => {
    for (const [id, pricing] of Object.entries(OPENAI_GENERATED_PRICING)) {
      expect(["openai", "openrouter"], id).toContain(pricing.priceSource)
      expect(["openai", "openrouter"], id).toContain(pricing.idSource)
    }
  })
})

describe("OPENAI_GENERATED_UNPRICED_IDS", () => {
  // Whether this list is empty or carries entries like `gpt-5.4-2026-03-05`
  // / `chat-latest` depends on OPENAI_API_KEY being available to the last
  // sync (that's the only source for ids OpenAI lists but nothing prices) —
  // an environment fact, not a code invariant, and asserting on its exact
  // membership is what broke catalog-sync's CI twice (2026-09-27, runs
  // 36288220170 and 36339321574) whenever that key misbehaved. The behavior
  // itself (which ids land here for a given fixture input) is covered
  // deterministically by openai-catalog.test.ts's mergeOpenAiCatalog suite.
  // What must hold regardless of which state the committed file is in:
  it("every listed id is known, and none is double-listed as priced", () => {
    for (const id of OPENAI_GENERATED_UNPRICED_IDS) {
      expect(isKnownLlmId(id), id).toBe(true)
      expect(id in OPENAI_GENERATED_PRICING, id).toBe(false)
    }
  })

  it("surfaces the ones nothing else prices through listUnpricedKnownLlmIds", () => {
    // `PRICING_OVERRIDES` may still hand-price an id the generator could not
    // (today: `gpt-5-codex`). Those are priced, so they are correctly absent
    // from the unpriced enumeration — the generator supplies existence, the
    // override supplies the number, and neither needs to know about the other.
    const listed = new Set(listUnpricedKnownLlmIds().map(e => e.id))
    for (const id of OPENAI_GENERATED_UNPRICED_IDS) {
      const priced = id in LLM_PRICING_CATALOG
      expect(listed.has(id), `${id} (priced=${priced})`).toBe(!priced)
    }
    // gpt-5-codex is a hand-typed PRICING_OVERRIDES entry, not generated —
    // stable regardless of catalog-sync's provenance for the day.
    expect(resolvePricing("gpt-5-codex")?.inputPer1M).toBe(1.25)
  })

  it("never lets a bare ambiguous key (e.g. chat-latest) hijack resolvePricing", () => {
    // `resolvePricing` falls back to `modelId.includes(key)`, so a bare
    // `chat-latest` pricing row would win for every `*-chat-latest` id and
    // reprice them. Whenever `chat-latest` shows up as unpriced-but-known
    // (which openai-catalog.test.ts proves it does for the ambiguous-bare-id
    // fixture), it must never win that fallback match.
    if ("chat-latest" in OPENAI_GENERATED_PRICING) return
    expect(resolvePricing("gpt-5-chat-latest")?.inputPer1M).not.toBe(5.0)
  })
})

describe("audio catalog: Google s2s entries are bidi Live models", () => {
  it("no TTS-only provider id rides in a Live seat, and the default matches the wire", async () => {
    const { AUDIO_MODEL_CATALOG, DEFAULT_GEMINI_LIVE_MODEL, GEMINI_LIVE_MODEL_IDS, isAcceptedGeminiLiveModel } =
      await import("../audio/catalog.js")
    const s2s = Object.entries(AUDIO_MODEL_CATALOG).filter(([, m]) => m.provider === "google" && m.capabilities.s2s)
    expect(s2s.length).toBeGreaterThanOrEqual(5)
    for (const [, m] of s2s) {
      // The Live API refuses the `*-tts`/`*preview-tts` variants: they only
      // take HTTP text input, so a Live seat must never point at one.
      expect(m.providerId, m.id).not.toMatch(/tts/)
    }
    expect(AUDIO_MODEL_CATALOG["google/gemini-live"]!.providerId).toBe("gemini-3.1-flash-live-preview")
    expect(AUDIO_MODEL_CATALOG["google/gemini-live-pro"]!.providerId).toBe("gemini-2.5-pro-live-preview")
    expect(AUDIO_MODEL_CATALOG["google/gemini-live-3.1-flash"]!.providerId).toBe("gemini-3.1-flash-live-preview")
    expect(DEFAULT_GEMINI_LIVE_MODEL).toBe("gemini-3.1-flash-live-preview")
    expect(isAcceptedGeminiLiveModel(DEFAULT_GEMINI_LIVE_MODEL)).toBe(true)
    expect(isAcceptedGeminiLiveModel("gemini-2.5-pro-preview-tts")).toBe(false)
    expect(GEMINI_LIVE_MODEL_IDS).toContain("gemini-2.5-pro-live-preview")
  })
})

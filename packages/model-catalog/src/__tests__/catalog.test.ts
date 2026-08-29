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
import { resolvePricing, resolveModelRoute, resolveContextWindow } from "../llm/catalog.js"

// ─── helpers ──────────────────────────────────────────────────────────────

/** Minimal stable LLM ResolvedModel for evaluator tests. */
function llmModel(id = "claude-sonnet-4-5"): ResolvedModel {
  return {
    kind: "llm",
    id,
    canonicalId: id,
    pricing: { inputPer1M: 3.0, outputPer1M: 15.0, provider: "anthropic", vendor: "anthropic" },
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
      const result = calculateCost("claude-sonnet-4-5", {
        kind: "llm",
        inputTokens: 1_000,
        outputTokens: 500,
      })
      expect(result.kind).toBe("llm")
      expect(result.modelId).toBe("claude-sonnet-4-5")
      expect(result.credits).toBeGreaterThan(0)
      expect(result.calculatedCredits).toBeGreaterThan(0)
      expect(result.baseCostUsd).toBeGreaterThan(0)
      expect(typeof result.markup).toBe("number")
    })

    it("returns a CostResult with LLM breakdown keys", () => {
      const result = calculateCost("gpt-4o", {
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
      const base = calculateCost("claude-sonnet-4-5", {
        kind: "llm",
        inputTokens: 1_000,
        outputTokens: 500,
      })
      const withCache = calculateCost("claude-sonnet-4-5", {
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
      aliases: { "my-sonnet-alias": "claude-sonnet-4-5" },
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
        "step-2": "claude-haiku-4-5",
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
      aliases: { "alias-to-clear": "claude-sonnet-4-5" },
    })
    expect(getModel("alias-to-clear")).toBeDefined()

    clearCatalogOverlays()

    expect(getModel("alias-to-clear")).toBeUndefined()
  })

  it("later overlay registration overrides earlier one for the same key", () => {
    registerCatalogOverlay({
      aliases: { "my-alias": "claude-haiku-4-5" },
    })
    registerCatalogOverlay({
      aliases: { "my-alias": "claude-sonnet-4-5" },
    })
    const resolved = getModel("my-alias")
    expect(resolved?.kind).toBe("llm")
    if (resolved?.kind === "llm") {
      // Should resolve to sonnet (the later registration)
      expect(resolved.canonicalId).toBe("claude-sonnet-4-5")
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
      expect(resolved.pricing.inputPer1M).toBe(1.0)
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

describe("LLM_PRICING_CATALOG — latest Anthropic ids", () => {
  // These ids are advertised by the claude-code / claude-sdk adapters; they
  // must resolve to a concrete anthropic-priced route so `agentproto models`
  // reports a price and marks them runnable.
  it.each([
    ["claude-opus-4-8", 5.0, 25.0],
    ["claude-sonnet-5", 3.0, 15.0],
    ["claude-fable-5", 10.0, 50.0],
  ])("%s resolves to anthropic pricing", (id, input, output) => {
    const pricing = resolvePricing(id)
    expect(pricing).toBeDefined()
    expect(pricing?.provider).toBe("anthropic")
    expect(pricing?.vendor).toBe("anthropic")
    expect(pricing?.inputPer1M).toBe(input)
    expect(pricing?.outputPer1M).toBe(output)

    const route = resolveModelRoute(id)
    expect(route?.provider).toBe("anthropic")
  })
})

describe("LLM_PRICING_CATALOG — Moonshot (Kimi)", () => {
  it.each([
    ["kimi-k3", 3.0, 15.0],
    ["kimi-k2.7-code", 0.95, 4.0],
  ])("%s resolves to expected direct-Moonshot pricing", (id, input, output) => {
    const pricing = resolvePricing(id)
    expect(pricing).toBeDefined()
    expect(pricing?.vendor).toBe("moonshot")
    expect(pricing?.provider).toBe("moonshot")
    expect(pricing?.inputPer1M).toBe(input)
    expect(pricing?.outputPer1M).toBe(output)
  })

  // OpenRouter-routed ids resolve to their own literal OPENROUTER_ROUTES
  // entry (vendor as OpenRouter reports it) BEFORE the alias table is even
  // consulted — resolvePricing tries a direct match first. Different vendor
  // string than the direct-SDK entries above by design.
  it.each([
    ["moonshotai/kimi-k3", 3.0, 15.0],
    ["moonshotai/kimi-k2.7-code", 0.67, 3.4],
  ])("%s resolves to expected OpenRouter-routed pricing", (id, input, output) => {
    const pricing = resolvePricing(id)
    expect(pricing).toBeDefined()
    expect(pricing?.vendor).toBe("moonshotai")
    expect(pricing?.provider).toBe("openrouter")
    expect(pricing?.inputPer1M).toBe(input)
    expect(pricing?.outputPer1M).toBe(output)
  })
})

describe("resolveContextWindow", () => {
  it.each([
    ["claude-opus-4-8", 1000000, 128000, "anthropic"],
    ["claude-sonnet-5", 1000000, 128000, "anthropic"],
    // Bare alias vs. the dated id the live Anthropic API actually returns.
    ["claude-haiku-4-5", 200000, 64000, "anthropic"],
    ["llama-3.3-70b-versatile", 131072, 32768, "groq"],
    ["kimi-k2.6", 262144, undefined, "moonshot"],
    ["kimi-k3", 1048576, undefined, "moonshot"],
  ])("%s resolves to a live context window", (id, contextWindow, maxOutput, provider) => {
    const entry = resolveContextWindow(id)
    expect(entry).toBeDefined()
    expect(entry?.contextWindow).toBe(contextWindow)
    expect(entry?.maxOutput).toBe(maxOutput)
    expect(entry?.provider).toBe(provider)
  })

  it("returns undefined for a non-synced provider", () => {
    expect(resolveContextWindow("gpt-4o")).toBeUndefined()
    expect(resolveContextWindow("glm-4.6")).toBeUndefined()
  })
})

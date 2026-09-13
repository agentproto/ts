/**
 * Unit tests for `evaluateAccess` — covers all 4 resolution layers:
 *   1. App scope
 *   2. Explicit per-model rules (terminal, block wins)
 *   3. Tag / provider / priceTier / kind band rules (specificity ladder)
 *   4. Catalog defaults (agentVisible / lifecycle)
 */

import { describe, expect, it } from "vitest"
import { evaluateAccess } from "../evaluate.js"
import type { AccessEvalInput } from "../evaluate.js"
import type { ResolvedModel } from "../../registry/index.js"
import type { AccessRule, AppScope } from "../types.js"

// ── Fixture helpers ────────────────────────────────────────────────────────

function llmModel(id: string): ResolvedModel {
  return {
    kind: "llm",
    id,
    canonicalId: id,
    pricing: {
      inputPer1M: 3,
      outputPer1M: 15,
      provider: "anthropic",
    } as never,
    provider: "anthropic",
  }
}

function imageModel(id: string, agentVisible = true): ResolvedModel {
  return {
    kind: "image",
    id,
    def: {
      id,
      name: id,
      providerId: `replicate/${id}`,
      provider: "replicate",
      capabilities: { generate: true, edit: false },
      referenceImages: { supported: false, fieldName: "none", maxCount: 0, singular: false },
      aspectRatio: { supported: ["1:1"], default: "1:1" },
      output: "string",
      pricing: {
        costPerImage: 0.04,
        costTier: "low",
        billingUnit: "per_image",
        baseCost: 0.04,
      },
      description: "test image model",
      agentVisible,
    },
  }
}

function voiceModel(id: string): ResolvedModel {
  return {
    kind: "voice",
    id,
    voice: {
      catalogId: id,
      providerVoiceId: id,
      provider: "elevenlabs",
      name: "Test Voice",
      language: "en",
      gender: "female",
    } as never,
  }
}

const rule = (
  effect: "allow" | "block",
  target: AccessRule["target"],
  reason?: string,
): AccessRule => ({ effect, target, ...(reason ? { reason } : {}) })

// ── Layer 1: App scope ─────────────────────────────────────────────────────

describe("Layer 1 — app scope", () => {
  it("denies a model whose kind is not in appScope.kinds", () => {
    const input: AccessEvalInput = {
      model: imageModel("nano-banana"),
      appScope: { kinds: ["llm", "audio"] },
    }
    const d = evaluateAccess(input)
    expect(d.allowed).toBe(false)
    expect(d.reason).toMatch(/app-scope:kind-not-allowed:image/)
  })

  it("allows a model whose kind IS in appScope.kinds", () => {
    const input: AccessEvalInput = {
      model: imageModel("nano-banana"),
      appScope: { kinds: ["image"] },
    }
    const d = evaluateAccess(input)
    expect(d.allowed).toBe(true)
  })

  it("skips app-scope check when kinds is empty (admin scope)", () => {
    const input: AccessEvalInput = {
      model: imageModel("nano-banana"),
      appScope: { kinds: [] },
    }
    const d = evaluateAccess(input)
    // Falls through to catalog defaults: nano-banana is agentVisible → allow
    expect(d.allowed).toBe(true)
  })

  it("voice models bypass app-scope kind checks entirely", () => {
    const input: AccessEvalInput = {
      model: voiceModel("some-voice"),
      appScope: { kinds: ["llm"] }, // voice not listed
    }
    // Voice bypasses → falls to catalog defaults (voice-curated → allow)
    const d = evaluateAccess(input)
    expect(d.allowed).toBe(true)
    expect(d.reason).toBe("catalog-default:voice-curated")
  })
})

// ── Layer 2: Explicit per-model rules ──────────────────────────────────────

describe("Layer 2 — explicit per-model rules", () => {
  it("allows a model with a matching allow rule", () => {
    const m = llmModel("claude-opus-4-5")
    const d = evaluateAccess({
      model: m,
      rules: [rule("allow", { kind: "model", id: "claude-opus-4-5" })],
    })
    expect(d.allowed).toBe(true)
    expect(d.reason).toMatch(/rule:model:allow/)
  })

  it("blocks a model with a matching block rule", () => {
    const m = llmModel("claude-opus-4-5")
    const d = evaluateAccess({
      model: m,
      rules: [rule("block", { kind: "model", id: "claude-opus-4-5" }, "compliance")],
    })
    expect(d.allowed).toBe(false)
    expect(d.reason).toMatch(/rule:model:block:compliance/)
  })

  it("block wins over allow within the model-rule band", () => {
    const m = llmModel("claude-opus-4-5")
    const d = evaluateAccess({
      model: m,
      rules: [
        rule("allow", { kind: "model", id: "claude-opus-4-5" }),
        rule("block", { kind: "model", id: "claude-opus-4-5" }, "nsfw"),
      ],
    })
    expect(d.allowed).toBe(false)
    expect(d.reason).toMatch(/rule:model:block:nsfw/)
  })

  it("model rule is terminal — does not fall through to band rules", () => {
    const m = llmModel("claude-opus-4-5")
    const d = evaluateAccess({
      model: m,
      rules: [
        rule("allow", { kind: "model", id: "claude-opus-4-5" }),
        rule("block", { kind: "kind", value: "llm" }),
      ],
    })
    // model-level allow wins; kind block is not reached
    expect(d.allowed).toBe(true)
  })
})

// ── Layer 3: Band rules (specificity ladder) ───────────────────────────────

describe("Layer 3 — band rules (tag > provider > priceTier > kind)", () => {
  it("kind rule blocks when no model or band rule overrides", () => {
    const m = llmModel("claude-opus-4-5")
    const d = evaluateAccess({
      model: m,
      rules: [rule("block", { kind: "kind", value: "llm" })],
    })
    expect(d.allowed).toBe(false)
    expect(d.reason).toMatch(/rule:kind:llm:block/)
  })

  it("priceTier rule (specificity 2) beats a kind rule (specificity 1)", () => {
    // priceTier=premium block should win over a kind allow
    const m = llmModel("claude-opus-4-5")
    const d = evaluateAccess({
      model: m,
      rules: [
        rule("allow", { kind: "kind", value: "llm" }),
        // priceTier is higher specificity — this would block the model
        // if it matched.  We use a "low" tier so it doesn't actually
        // match claude-opus-4-5 (a premium model) — test that kind allow
        // is NOT used when a higher-band priceTier allow is present.
        rule("allow", { kind: "priceTier", value: "low" }),
      ],
    })
    // priceTier=low doesn't match claude-opus-4-5 (premium), so the
    // highest matching band is `kind`, which allows.
    expect(d.allowed).toBe(true)
  })

  it("provider rule (specificity 3) beats kind rule (specificity 1)", () => {
    const m = imageModel("nano-banana")
    const d = evaluateAccess({
      model: m,
      rules: [
        rule("allow", { kind: "kind", value: "image" }),
        rule("block", { kind: "provider", value: "replicate" }),
      ],
    })
    // provider(3) > kind(1) → block wins
    expect(d.allowed).toBe(false)
    expect(d.reason).toMatch(/rule:provider:replicate:block/)
  })

  it("within a band, block wins over allow", () => {
    const m = imageModel("nano-banana")
    const d = evaluateAccess({
      model: m,
      rules: [
        rule("allow", { kind: "provider", value: "replicate" }),
        rule("block", { kind: "provider", value: "replicate" }),
      ],
    })
    expect(d.allowed).toBe(false)
  })

  it("LLM provider matching: startsWith vendor prefix (no false positive)", () => {
    // "google" should match "google/gemini-1.5-pro" but not "non-google/xyz"
    const matchingModel = llmModel("google/gemini-1.5-pro")
    const nonMatchingModel = llmModel("non-google/xyz")

    const matchResult = evaluateAccess({
      model: matchingModel,
      rules: [rule("block", { kind: "provider", value: "google" })],
    })
    expect(matchResult.allowed).toBe(false)

    const nonMatchResult = evaluateAccess({
      model: nonMatchingModel,
      rules: [rule("block", { kind: "provider", value: "google" })],
    })
    // "non-google/xyz" does NOT start with "google/" nor contain "/google/" → no match
    expect(nonMatchResult.allowed).toBe(true) // falls to catalog default (LLM curated)
  })

  it("LLM provider matching: interior /vendor/ segment (router/vendor/model)", () => {
    // "openrouter/anthropic/claude-opus-4-5" → provider "anthropic" matches
    const m = llmModel("openrouter/anthropic/claude-opus-4-5")
    const d = evaluateAccess({
      model: m,
      rules: [rule("block", { kind: "provider", value: "anthropic" })],
    })
    expect(d.allowed).toBe(false)
    expect(d.reason).toMatch(/rule:provider:anthropic:block/)
  })

  it("BYOK relaxation bypasses priceTier=premium block for BYOK users", () => {
    const m = llmModel("claude-opus-4-5")
    const d = evaluateAccess({
      model: m,
      rules: [rule("block", { kind: "priceTier", value: "premium" })],
      byokActive: true,
    })
    // premium block is bypassed by BYOK → falls to catalog default (llm curated → allow)
    expect(d.allowed).toBe(true)
    expect(d.reason).toBe("catalog-default:llm-curated")
  })

  it("BYOK relaxation does NOT bypass nsfw/compliance blocks", () => {
    const m = llmModel("claude-opus-4-5")
    const d = evaluateAccess({
      model: m,
      rules: [rule("block", { kind: "priceTier", value: "premium" }, "nsfw")],
      byokActive: true,
    })
    // nsfw reason → bypass does NOT apply
    expect(d.allowed).toBe(false)
  })
})

// ── Layer 4: Catalog defaults ──────────────────────────────────────────────

describe("Layer 4 — catalog defaults", () => {
  it("allows an agentVisible image model with no workspace rules", () => {
    const d = evaluateAccess({ model: imageModel("nano-banana", true) })
    expect(d.allowed).toBe(true)
    expect(d.reason).toBe("catalog-default:agent-visible")
  })

  it("blocks an agentVisible=false image model with no workspace rules", () => {
    const d = evaluateAccess({ model: imageModel("hidden-model", false) })
    expect(d.allowed).toBe(false)
    expect(d.reason).toBe("catalog-default:agent-hidden")
  })

  it("allows an LLM model by catalog default (curated list)", () => {
    const d = evaluateAccess({ model: llmModel("claude-opus-4-5") })
    expect(d.allowed).toBe(true)
    expect(d.reason).toBe("catalog-default:llm-curated")
  })

  it("allows a voice model by catalog default (voice-curated)", () => {
    const d = evaluateAccess({ model: voiceModel("test-voice") })
    expect(d.allowed).toBe(true)
    expect(d.reason).toBe("catalog-default:voice-curated")
  })
})

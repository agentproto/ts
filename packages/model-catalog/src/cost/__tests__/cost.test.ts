import { afterEach, describe, expect, it } from "vitest"
import {
  calculateCost,
  CostUsageKindMismatchError,
  UnknownModelError,
} from "../index.js"
import { pricingRegistry } from "../../pricing/index.js"

afterEach(() => pricingRegistry.reset())

describe("calculateCost", () => {
  it("prices an LLM run (pass-through to the token formula)", () => {
    const r = calculateCost("claude-opus-4-5", {
      kind: "llm",
      inputTokens: 1000,
      outputTokens: 1000,
    })
    expect(r.kind).toBe("llm")
    expect(r.canonicalId).toBe("claude-opus-4-5")
    expect(r.credits).toBeGreaterThan(0)
    expect(r.breakdown.inputCredits).toBeGreaterThanOrEqual(0)
  })

  it("returns LLM fallback pricing for an unknown LLM id (no throw)", () => {
    const r = calculateCost("totally-made-up-llm-xyz", {
      kind: "llm",
      inputTokens: 100,
      outputTokens: 100,
    })
    expect(r.kind).toBe("llm")
    expect(r.isFallback).toBe(true)
  })

  it("prices an image run × numOutputs", () => {
    const one = calculateCost("nano-banana", { kind: "image", numOutputs: 1 })
    const three = calculateCost("nano-banana", { kind: "image", numOutputs: 3 })
    expect(one.kind).toBe("image")
    expect(one.breakdown.numOutputs).toBe(1)
    expect(three.breakdown.numOutputs).toBe(3)
    expect(three.credits).toBe(one.credits * 3)
  })

  it("throws UnknownModelError for an unknown non-LLM id", () => {
    expect(() =>
      calculateCost("not-a-real-image-model", { kind: "image" }),
    ).toThrow(UnknownModelError)
  })

  it("throws CostUsageKindMismatchError reporting the expected kind", () => {
    try {
      calculateCost("nano-banana", { kind: "audio", characters: 100 })
      throw new Error("expected a CostUsageKindMismatchError")
    } catch (e) {
      expect(e).toBeInstanceOf(CostUsageKindMismatchError)
      expect((e as CostUsageKindMismatchError).expected).toBe("image")
    }
  })

  it("bills a voice id through its provider's default audio model", () => {
    const r = calculateCost("elevenlabs-victoire", {
      kind: "audio",
      characters: 1000,
    })
    expect(r.kind).toBe("audio")
    // Surface modelId stays the voice the caller asked for…
    expect(r.modelId).toBe("elevenlabs-victoire")
    // …and it actually bills (delegates to elevenlabs/flash-v2.5).
    expect(r.credits).toBeGreaterThan(0)
  })

  it("bills a per_1k_chars TTS model by characters (regression: not 0)", () => {
    const r = calculateCost("elevenlabs/flash-v2.5", {
      kind: "audio",
      characters: 1000,
    })
    expect(r.kind).toBe("audio")
    expect(r.credits).toBeGreaterThan(0)
    expect(r.breakdown.quantity).toBe(1) // 1000 chars / 1000
  })

  it("bills a per_minute STT model by whole minutes (regression: not seconds)", () => {
    const r = calculateCost("google/gemini-live", {
      kind: "audio",
      seconds: 90,
    })
    expect(r.kind).toBe("audio")
    expect(r.credits).toBeGreaterThan(0)
    expect(r.breakdown.quantity).toBe(2) // ceil(90/60) = 2 minutes
  })

  it("an empty TTS call bills nothing", () => {
    const r = calculateCost("elevenlabs/flash-v2.5", {
      kind: "audio",
      characters: 0,
    })
    expect(r.credits).toBe(0)
  })

  it("voice mismatch reports expected kind 'audio', not 'voice' (regression)", () => {
    try {
      // a voice expects audio usage — passing image must say expected=audio
      calculateCost("elevenlabs-victoire", { kind: "image" })
      throw new Error("expected a CostUsageKindMismatchError")
    } catch (e) {
      expect(e).toBeInstanceOf(CostUsageKindMismatchError)
      expect((e as CostUsageKindMismatchError).expected).toBe("audio")
    }
  })
})

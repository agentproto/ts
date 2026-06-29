import { describe, expect, it } from "vitest"
import { priceTierForModel } from "../index.js"
import type { ResolvedModel } from "../../registry/index.js"

// Minimal stubs — priceTierForModel only reads `kind` + the one pricing field
// per kind, so narrow casts keep these boundary tests focused on the bucket
// thresholds (the gauge that drives the picker's price bar).
const llm = (outputPer1M: number) =>
  ({ kind: "llm", pricing: { outputPer1M } }) as unknown as ResolvedModel
const media = (kind: "image" | "video" | "audio", baseCost: number) =>
  ({ kind, def: { pricing: { baseCost } } }) as unknown as ResolvedModel

describe("priceTierForModel — bucket boundaries", () => {
  it("LLM by outputPer1M (≤1,≤10,≤30,≤75, else)", () => {
    expect(priceTierForModel(llm(1))).toBe(1)
    expect(priceTierForModel(llm(1.01))).toBe(2)
    expect(priceTierForModel(llm(10))).toBe(2)
    expect(priceTierForModel(llm(10.01))).toBe(3)
    expect(priceTierForModel(llm(30))).toBe(3)
    expect(priceTierForModel(llm(30.01))).toBe(4)
    expect(priceTierForModel(llm(75))).toBe(4)
    expect(priceTierForModel(llm(75.01))).toBe(5)
  })

  it("image by baseCost (≤0.02,≤0.05,≤0.1,≤0.2, else)", () => {
    expect(priceTierForModel(media("image", 0.02))).toBe(1)
    expect(priceTierForModel(media("image", 0.05))).toBe(2)
    expect(priceTierForModel(media("image", 0.1))).toBe(3)
    expect(priceTierForModel(media("image", 0.2))).toBe(4)
    expect(priceTierForModel(media("image", 0.21))).toBe(5)
  })

  it("video by baseCost (≤0.3,≤0.7,≤1.2,≤2.5, else)", () => {
    expect(priceTierForModel(media("video", 0.3))).toBe(1)
    expect(priceTierForModel(media("video", 0.7))).toBe(2)
    expect(priceTierForModel(media("video", 1.2))).toBe(3)
    expect(priceTierForModel(media("video", 2.5))).toBe(4)
    expect(priceTierForModel(media("video", 2.51))).toBe(5)
  })

  it("audio by baseCost (≤0.01,≤0.05,≤0.2,≤0.5, else)", () => {
    expect(priceTierForModel(media("audio", 0.01))).toBe(1)
    expect(priceTierForModel(media("audio", 0.05))).toBe(2)
    expect(priceTierForModel(media("audio", 0.2))).toBe(3)
    expect(priceTierForModel(media("audio", 0.5))).toBe(4)
    expect(priceTierForModel(media("audio", 0.51))).toBe(5)
  })

  it("voice is always tier 1 (render-target, not priced)", () => {
    expect(priceTierForModel({ kind: "voice" } as unknown as ResolvedModel)).toBe(1)
  })
})

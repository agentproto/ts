import { describe, expect, it } from "vitest"
import type { ResolvedModel } from "../../registry/index.js"
import { getEnrichment, isZeroPriced } from "../index.js"

function llm(
  id: string,
  inputPer1M: number,
  outputPer1M: number,
  tiers?: Array<{ aboveInputTokens: number; inputPer1M: number; outputPer1M: number }>,
): ResolvedModel {
  return {
    kind: "llm",
    id,
    canonicalId: id,
    pricing: { inputPer1M, outputPer1M, ...(tiers ? { tiers } : {}) },
    provider: "openai",
  }
}

describe("price:zero enrichment tag", () => {
  it("isZeroPriced requires both token prices to be exactly zero", () => {
    expect(isZeroPriced({ inputPer1M: 0, outputPer1M: 0 })).toBe(true)
    expect(isZeroPriced({ inputPer1M: 0, outputPer1M: 0.1 })).toBe(false)
    expect(isZeroPriced({ inputPer1M: 0.1, outputPer1M: 0 })).toBe(false)
  })

  it("tags a zero-priced model on the INFERRED path", () => {
    expect(getEnrichment(llm("not-in-the-explicit-map", 0, 0)).tags).toContain(
      "price:zero",
    )
  })

  it("tags a zero-priced model on the EXPLICIT-enrichment path", () => {
    // `gpt-4o` is in EXPLICIT_ENRICHMENT, which returns before inferTags.
    const enrichment = getEnrichment(llm("gpt-4o", 0, 0))
    expect(enrichment.tags).toContain("price:zero")
    expect(enrichment.tags.filter(tag => tag === "price:zero")).toHaveLength(1)
  })

  it("does not tag a paid model", () => {
    expect(getEnrichment(llm("gpt-4o", 2.5, 10)).tags).not.toContain("price:zero")
  })

  it("does not tag a 0/0 base model whose prompt-length tier bills", () => {
    expect(
      isZeroPriced({
        inputPer1M: 0,
        outputPer1M: 0,
        tiers: [
          { aboveInputTokens: 200_000, inputPer1M: 0.5, outputPer1M: 2 },
        ],
      }),
    ).toBe(false)
    expect(
      getEnrichment(
        llm("free-base-paid-tier", 0, 0, [
          { aboveInputTokens: 200_000, inputPer1M: 0.5, outputPer1M: 2 },
        ]),
      ).tags,
    ).not.toContain("price:zero")
  })

  it("tags a model only when its base and every tier are 0/0", () => {
    expect(
      getEnrichment(
        llm("all-free-tiers", 0, 0, [
          { aboveInputTokens: 200_000, inputPer1M: 0, outputPer1M: 0 },
        ]),
      ).tags,
    ).toContain("price:zero")
  })
})

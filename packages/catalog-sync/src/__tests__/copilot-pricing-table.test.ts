import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import {
  checkCopilotPricingUsable,
  copilotModelId,
  parseCopilotPricing,
  parseCopilotPromoFootnotes,
} from "../sources/copilot-pricing-table.mjs"

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures")
// Verbatim from github/docs `main`, fetched 2026-11-18: the table, and the
// footnote lines of the page (the rest of the page is Liquid templating).
const YAML = readFileSync(join(FIXTURES, "copilot-models-and-pricing.yml"), "utf8")
const FOOTNOTES = readFileSync(join(FIXTURES, "copilot-promo-footnotes.md"), "utf8")

describe("parseCopilotPricing", () => {
  const prices = parseCopilotPricing(YAML, FOOTNOTES)

  it("prices MAI Code 2 and Flash at the promo rate, with the dated standard price", () => {
    expect(prices.get("mai-code-2")).toEqual({
      inputPer1M: 0.5,
      outputPer1M: 2.5,
      cacheReadMultiplier: 0.05,
      vendor: "microsoft",
      promo: { until: "2027-05-17", then: { inputPer1M: 1, outputPer1M: 5, cacheReadMultiplier: 0.05 } },
    })
    expect(prices.get("mai-code-2-flash")).toEqual({
      inputPer1M: 0.05,
      outputPer1M: 0.25,
      cacheReadMultiplier: 0.1,
      vendor: "microsoft",
      promo: { until: "2027-05-17", then: { inputPer1M: 0.1, outputPer1M: 0.5, cacheReadMultiplier: 0.1 } },
    })
  })

  it("uses Copilot's own id spelling (dotted) and keeps cache-write and prompt tiers", () => {
    expect(prices.get("claude-sonnet-5.5")).toMatchObject({ inputPer1M: 2, outputPer1M: 10, cacheWriteMultiplier: 1.25 })
    expect(prices.get("claude-haiku-5.5")?.tiers).toEqual([
      { aboveInputTokens: 100000, inputPer1M: 0.5, outputPer1M: 2.5, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25 },
    ])
    expect(prices.get("mai-code-1.1-flash")).toMatchObject({ inputPer1M: 0.2, outputPer1M: 1.2 })
  })

  it("skips qualifier rows that are not model ids", () => {
    expect([...prices.keys()].some(id => id.includes("("))).toBe(false)
  })

  it("accepts the committed fixture and rejects a changed layout", () => {
    expect(checkCopilotPricingUsable(prices)).toBeNull()
    expect(checkCopilotPricingUsable(parseCopilotPricing("- model: x\n"))).toMatch(/only 0 priced rows/)
  })
})

describe("parseCopilotPromoFootnotes", () => {
  it("reads the until date, and the post-promo price only when stated", () => {
    const notes = parseCopilotPromoFootnotes(FOOTNOTES)
    expect(notes.get("mai-code-2-promo")?.until).toBe("2027-05-17")
    expect(notes.get("gemini-flash-promo")).toEqual({ until: "2026-12-31" })
  })
})

describe("copilotModelId", () => {
  it("slugs display names and drops footnote markers", () => {
    expect(copilotModelId("MAI Code 2[^mai-code-2-promo]")).toBe("mai-code-2")
    expect(copilotModelId("Claude Sonnet 5.5")).toBe("claude-sonnet-5.5")
  })
})

import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { checkAnthropicPricingUsable, parseAnthropicPricingPage } from "../sources/anthropic-pricing-page.mjs"
import { checkKimiPricingUsable, parseKimiPricingPage } from "../sources/kimi-pricing-page.mjs"
import { checkMiniMaxPricingUsable, parseMiniMaxPricingPage } from "../sources/minimax-pricing-page.mjs"

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures")
// Verbatim `.md` renderings fetched 2026-10-08 (Anthropic: the page head
// through the "Model pricing" table).
const KIMI_PAGE = readFileSync(join(FIXTURES, "kimi-pricing-chat.md"), "utf8")
const ANTHROPIC_PAGE = readFileSync(join(FIXTURES, "anthropic-pricing.md"), "utf8")
// MiniMax: the page head through the "## LLM" section.
const MINIMAX_PAGE = readFileSync(join(FIXTURES, "minimax-pricing-paygo.md"), "utf8")

describe("parseKimiPricingPage", () => {
  const prices = parseKimiPricingPage(KIMI_PAGE)

  it("reads Moonshot's own rates, not OpenRouter's host rates", () => {
    expect(prices.get("kimi-k3")).toEqual({ inputPer1M: 3, outputPer1M: 15, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1 })
    expect(prices.get("kimi-k2.7-code")).toEqual({ inputPer1M: 0.95, outputPer1M: 4, cacheReadMultiplier: 0.2 })
    expect(prices.get("kimi-k2.7-code-highspeed")).toEqual({ inputPer1M: 1.9, outputPer1M: 8, cacheReadMultiplier: 0.2 })
    expect(prices.get("kimi-k2.6")).toEqual({ inputPer1M: 0.95, outputPer1M: 4, cacheReadMultiplier: 0.168421 })
    expect(checkKimiPricingUsable(prices)).toBeNull()
  })

  it("maps cells by column title, not position", () => {
    const page = `<DocTable
  columns={[
{ title: "Output Price" },
{ title: "Model" },
{ title: "Input Price (Cache Miss)" },
{ title: "Unit" },
]}
  rows={[
["$7.00", "kimi-x", <>{"$"}2.00</>, "1M tokens"],
["$1.00", "kimi-per-1k", <>{"$"}1.00</>, "1K tokens"],
]}
/>`
    expect([...parseKimiPricingPage(page)]).toEqual([["kimi-x", { inputPer1M: 2, outputPer1M: 7 }]])
  })

  it("rejects a parse with no usable rows", () => {
    expect(checkKimiPricingUsable(parseKimiPricingPage("# Pricing moved"))).toMatch(/no priced rows/)
  })
})

describe("parseAnthropicPricingPage", () => {
  const prices = parseAnthropicPricingPage(ANTHROPIC_PAGE)

  it("maps display names to API ids and reads first-party cache rates", () => {
    expect(prices.get("claude-sonnet-5-5")).toEqual({ inputPer1M: 2, outputPer1M: 10, cacheReadMultiplier: 0.05, cacheWriteMultiplier: 1.25 })
    expect(prices.get("claude-fable-5-1")).toMatchObject({ inputPer1M: 10, cacheReadMultiplier: 0.025 })
    // "Claude Opus 4 ([retired, …](…))" — link parenthetical dropped.
    expect(prices.get("claude-opus-4")).toMatchObject({ inputPer1M: 15, outputPer1M: 75 })
    expect(checkAnthropicPricingUsable(prices)).toBeNull()
  })

  it("folds the 'up to' / 'over' 100k rows into a tier", () => {
    expect(prices.get("claude-haiku-5-5")).toEqual({
      inputPer1M: 0.1,
      outputPer1M: 0.5,
      cacheReadMultiplier: 0.1,
      cacheWriteMultiplier: 1.25,
      tiers: [{ aboveInputTokens: 100000, inputPer1M: 0.5, outputPer1M: 2.5, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25 }],
    })
  })

  it("prices Sonnet 4.5 flat — no OpenRouter-only long-context tier", () => {
    expect(prices.get("claude-sonnet-4-5")?.tiers).toBeUndefined()
  })

  it("rejects a page whose table is gone", () => {
    expect(checkAnthropicPricingUsable(parseAnthropicPricingPage("## Model pricing\n\nSee claude.com"))).toMatch(/only 0 priced rows/)
  })
})

describe("parseMiniMaxPricingPage", () => {
  const prices = parseMiniMaxPricingPage(MINIMAX_PAGE)

  it("reads MiniMax's own rates, cache writes included", () => {
    expect(prices.get("MiniMax-M2.7")).toEqual({ inputPer1M: 0.3, outputPer1M: 1.2, cacheReadMultiplier: 0.2, cacheWriteMultiplier: 1.25 })
    expect(prices.get("MiniMax-M2.5-highspeed")).toEqual({ inputPer1M: 0.6, outputPer1M: 2.4, cacheReadMultiplier: 0.05, cacheWriteMultiplier: 0.625 })
    expect(checkMiniMaxPricingUsable(prices)).toBeNull()
  })

  it("bills the sale price, keeps the Standard tab and folds the >512k row into a tier", () => {
    // Standard: ~~$0.60~~ $0.30; the Priority tab ($0.45) is opt-in and skipped.
    expect(prices.get("MiniMax-M3")).toEqual({
      inputPer1M: 0.3,
      outputPer1M: 1.2,
      cacheReadMultiplier: 0.2,
      tiers: [{ aboveInputTokens: 512000, inputPer1M: 0.6, outputPer1M: 2.4, cacheReadMultiplier: 0.2 }],
    })
  })

  it("lists every model on the page, legacy accordion included", () => {
    expect([...prices.keys()].sort()).toEqual([
      "MiniMax-M2",
      "MiniMax-M2.1",
      "MiniMax-M2.1-highspeed",
      "MiniMax-M2.5",
      "MiniMax-M2.5-highspeed",
      "MiniMax-M2.7",
      "MiniMax-M2.7-highspeed",
      "MiniMax-M3",
    ])
  })

  it("rejects a page without an LLM table", () => {
    expect(checkMiniMaxPricingUsable(parseMiniMaxPricingPage("# Pay as You Go\n\n## Audio"))).toMatch(/no priced rows/)
  })
})

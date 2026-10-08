/**
 * Anthropic first-party pricing, parsed from the Markdown rendering of
 * https://platform.claude.com/docs/en/about-claude/pricing.md ("Model
 * pricing" table). Plain JS (types in `anthropic-pricing-page.d.mts`) so the
 * bare-`node` sync script and the tests share it.
 *
 * WHY: Anthropic's `/v1/models` carries no price, so sync-anthropic.mjs used
 * to take every price from OpenRouter, which lags and sometimes disagrees:
 * 2026-10-06 it still had Claude Sonnet 5.5 cache hits at 0.1x (Anthropic:
 * 0.05x), and it shows a >200k tier on Claude Sonnet 4.5 that Anthropic's
 * page doesn't list.
 *
 * GFM pipe table, parsed by COLUMN NAME, never by position. Display names
 * map to API ids mechanically ("Claude Opus 5.5" → `claude-opus-5-5`).
 * Prompt-length rows — "Claude Haiku 5.5 (for prompts up to 100,000
 * tokens)" / "(for prompts over 100,000 tokens)" — fold into one row whose
 * `tiers` carries the "over" prices.
 */

function round6(n) {
  return Math.round(n * 1_000_000) / 1_000_000
}

/** "$0.50 / MTok<sup>2</sup>" → 0.5 */
function priceOf(cell) {
  const m = /\$\s*([\d.]+)\s*\/\s*MTok/i.exec(cell ?? "")
  if (!m) return undefined
  const n = Number(m[1])
  return Number.isFinite(n) ? n : undefined
}

function splitRow(line) {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim())
}

/**
 * "Claude Haiku 5.5 (for prompts over 100,000 tokens)" →
 * `{ id: "claude-haiku-5-5", over: 100000 }`; links and footnotes dropped.
 */
function modelOf(cell) {
  let name = cell.replace(/<sup>.*?<\/sup>/g, "")
  let over
  const tier = /\(for prompts (up to|over) ([\d,]+) tokens\)/i.exec(name)
  if (tier) {
    if (tier[1].toLowerCase() === "over") over = Number(tier[2].replace(/,/g, ""))
    name = name.replace(tier[0], "")
  }
  // "([retired, …](https://…))" and any other parenthetical.
  name = name.replace(/\(\[[^\]]*\]\([^)]*\)\)/g, "").replace(/\([^)]*\)/g, "").trim()
  if (!/^Claude\s/i.test(name)) return undefined
  const id = name.toLowerCase().replace(/[\s.]+/g, "-")
  return { id, over }
}

/**
 * @param {string} markdown the pricing page's `.md` body
 * @returns {Map<string, import("./anthropic-pricing-page.d.mts").AnthropicPrice>}
 */
export function parseAnthropicPricingPage(markdown) {
  const prices = new Map()
  const lines = markdown.split("\n")
  const start = lines.findIndex((l) => /^##\s+Model pricing\s*$/i.test(l))
  if (start === -1) return prices
  const headerAt = lines.findIndex((l, i) => i > start && l.trim().startsWith("|"))
  if (headerAt === -1) return prices

  const titles = splitRow(lines[headerAt]).map((t) => t.toLowerCase())
  const col = (name) => titles.indexOf(name)
  const c = {
    model: col("model"),
    input: col("base input tokens"),
    cacheWrite: col("5m cache writes"),
    cacheRead: col("cache hits and refreshes"),
    output: col("output tokens"),
  }
  if (c.model === -1 || c.input === -1 || c.output === -1) return prices

  const tiers = []
  for (let i = headerAt + 2; i < lines.length && lines[i].trim().startsWith("|"); i++) {
    const cells = splitRow(lines[i])
    const model = modelOf(cells[c.model] ?? "")
    if (!model) continue
    const inputPer1M = priceOf(cells[c.input])
    const outputPer1M = priceOf(cells[c.output])
    if (inputPer1M === undefined || outputPer1M === undefined) continue
    const price = { inputPer1M, outputPer1M }
    const cacheRead = c.cacheRead === -1 ? undefined : priceOf(cells[c.cacheRead])
    if (cacheRead !== undefined && inputPer1M > 0) price.cacheReadMultiplier = round6(cacheRead / inputPer1M)
    const cacheWrite = c.cacheWrite === -1 ? undefined : priceOf(cells[c.cacheWrite])
    if (cacheWrite !== undefined && inputPer1M > 0) price.cacheWriteMultiplier = round6(cacheWrite / inputPer1M)

    if (model.over !== undefined) tiers.push({ id: model.id, tier: { aboveInputTokens: model.over, ...price } })
    else prices.set(model.id, price)
  }
  for (const { id, tier } of tiers) {
    const base = prices.get(id)
    if (!base) continue // an "over" row with no base row is not a usable tier
    base.tiers = [...(base.tiers ?? []), tier].sort((a, b) => a.aboveInputTokens - b.aboveInputTokens)
  }
  return prices
}

/**
 * Null when the parse looks trustworthy, else a reason. A page restructure
 * must degrade to OpenRouter prices, never to a catalog of wrong numbers.
 *
 * @param {Map<string, unknown>} prices
 */
export function checkAnthropicPricingUsable(prices) {
  if (prices.size < 5) return `only ${prices.size} priced rows parsed from the Anthropic pricing page`
  if (!["opus", "sonnet", "haiku"].every((family) => [...prices.keys()].some((id) => id.startsWith(`claude-${family}-`)))) {
    return "an Opus, Sonnet or Haiku row is missing from the parsed Anthropic pricing table"
  }
  return null
}

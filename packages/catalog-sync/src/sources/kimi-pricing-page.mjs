/**
 * Kimi (Moonshot) first-party pricing, parsed from the Markdown rendering of
 * https://platform.kimi.ai/docs/pricing/chat.md (platform.moonshot.ai
 * redirects there). Plain JS (types in `kimi-pricing-page.d.mts`) so the
 * bare-`node` sync script and the tests share it.
 *
 * WHY: OpenRouter's `moonshotai/*` price is whatever the host OpenRouter
 * routes to charges, not Moonshot's rate, and it moves week to week —
 * 2026-10-08 it had kimi-k3 at $0.62 / $12.30 against Moonshot's own
 * $3.00 / $15.00. A model called through the Moonshot API is billed at
 * Moonshot's price, so that is the price the catalog must carry.
 *
 * The page is MDX: each table is a `<DocTable columns={[{ title: … }]}
 * rows={[[…], …]} />` block. Cells are parsed by COLUMN TITLE, never by
 * position (the K3 and K2 tables already order their columns differently).
 * Price cells look like `<>{"$"}3.00</>`; units are "1M tokens".
 */

const PRICE_CELL = /<>\{"\$"\}([\d.]+)<\/>|"([^"]*)"/g

function round6(n) {
  return Math.round(n * 1_000_000) / 1_000_000
}

/** A price cell's value in USD, or undefined when it isn't a price. */
function priceOf(cell) {
  if (cell === undefined) return undefined
  const m = /^\$?\s*([\d.]+)$/.exec(cell.trim())
  if (!m) return undefined
  const n = Number(m[1])
  return Number.isFinite(n) ? n : undefined
}

/** First column whose title matches, by case-insensitive exact title. */
function columnIndex(titles, ...candidates) {
  const lower = titles.map((t) => t.toLowerCase())
  for (const c of candidates) {
    const i = lower.indexOf(c.toLowerCase())
    if (i !== -1) return i
  }
  return -1
}

/**
 * @param {string} markdown the pricing page's `.md` body
 * @returns {Map<string, import("./kimi-pricing-page.d.mts").KimiPrice>}
 *   model id → USD per 1M tokens, plus cache ratios relative to input.
 */
export function parseKimiPricingPage(markdown) {
  const prices = new Map()
  const tables = markdown.matchAll(/<DocTable\s+columns=\{\[([\s\S]*?)\]\}\s+rows=\{\[([\s\S]*?)\]\}\s*\/>/g)
  for (const [, columnsSrc, rowsSrc] of tables) {
    const titles = [...columnsSrc.matchAll(/title:\s*"([^"]*)"/g)].map((m) => m[1])
    const col = {
      model: columnIndex(titles, "Model"),
      unit: columnIndex(titles, "Unit"),
      input: columnIndex(titles, "Input Price", "Input Price (Cache Miss)"),
      output: columnIndex(titles, "Output Price"),
      cacheRead: columnIndex(titles, "Cached Input Price", "Input Price (Cache Hit)"),
      // The 5-minute TTL is the API's default cache write.
      cacheWrite: columnIndex(titles, "Cache Write Price (TTL 5min)", "Cache Write Price"),
    }
    if (col.model === -1 || col.input === -1 || col.output === -1) continue

    for (const [, rowSrc] of rowsSrc.matchAll(/^\s*\[(.*)\],?\s*$/gm)) {
      const cells = [...rowSrc.matchAll(PRICE_CELL)].map((m) => (m[1] !== undefined ? `$${m[1]}` : m[2]))
      const id = cells[col.model]
      if (!id) continue
      if (col.unit !== -1 && cells[col.unit] !== "1M tokens") continue
      const inputPer1M = priceOf(cells[col.input])
      const outputPer1M = priceOf(cells[col.output])
      if (inputPer1M === undefined || outputPer1M === undefined) continue
      const price = { inputPer1M, outputPer1M }
      const cacheRead = col.cacheRead === -1 ? undefined : priceOf(cells[col.cacheRead])
      if (cacheRead !== undefined && inputPer1M > 0) price.cacheReadMultiplier = round6(cacheRead / inputPer1M)
      const cacheWrite = col.cacheWrite === -1 ? undefined : priceOf(cells[col.cacheWrite])
      if (cacheWrite !== undefined && inputPer1M > 0) price.cacheWriteMultiplier = round6(cacheWrite / inputPer1M)
      prices.set(id, price)
    }
  }
  return prices
}

/**
 * Null when the parse looks trustworthy, else a reason. A page restructure
 * must degrade to OpenRouter prices, never to a catalog of wrong numbers.
 *
 * @param {Map<string, unknown>} prices
 */
export function checkKimiPricingUsable(prices) {
  if (prices.size === 0) return "no priced rows parsed from the Kimi pricing page"
  if (![...prices.keys()].some((id) => id.startsWith("kimi-"))) {
    return "no kimi-* model among the parsed rows"
  }
  return null
}

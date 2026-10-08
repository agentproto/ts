/**
 * MiniMax first-party pricing, parsed from the Markdown rendering of
 * https://platform.minimax.io/docs/guides/pricing-paygo.md ("## LLM"
 * section). Plain JS (types in `minimax-pricing-page.d.mts`) so the
 * bare-`node` sync script and the tests share it.
 *
 * WHY: sync-minimax.mjs took every price from OpenRouter's `minimax/*`
 * routes, which disagree with MiniMax's own rates (2026-10-08: MiniMax-M2.7
 * $0.21 / $0.84 on OpenRouter vs $0.30 / $1.20 at MiniMax) and carry no
 * cache-write price at all. MiniMax has no usable id API for us either, so
 * the page's model column is also the first-party id list (MiniMax-M3, the
 * `-highspeed` variants).
 *
 * Parsing rules:
 *   - GFM pipe tables in the "## LLM" section, cells by COLUMN NAME.
 *   - Only the default tier: a table inside `<Tab title="…">` other than
 *     "Standard" (e.g. "Priority*", opt-in via `service_tier`, 1.5x) is skipped.
 *   - Model cell `**MiniMax-M3**<br />≤ 512k input tokens <span>…` → id in
 *     bold; "≤ Nk" is the base row, "> Nk" a prompt-length tier with
 *     `aboveInputTokens` N × 1000 (the page's "k").
 *   - Price cells may show a struck list price before the real one
 *     (`~~\$0.60~~ \$0.30 / M tokens`); the LAST dollar amount is billed.
 */

function round6(n) {
  return Math.round(n * 1_000_000) / 1_000_000
}

function splitRow(line) {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim())
}

/** Last "$X" in a "/ M tokens" cell → X, struck-through list prices skipped. */
function priceOf(cell) {
  if (!cell || !/\/\s*M tokens/i.test(cell)) return undefined
  const amounts = [...cell.replace(/~~[^~]*~~/g, "").matchAll(/\$\s*([\d.]+)/g)]
  const last = amounts.at(-1)
  if (!last) return undefined
  const n = Number(last[1])
  return Number.isFinite(n) ? n : undefined
}

/** "**MiniMax-M3**<br />> 512k input tokens…" → `{ id, over }`. */
function modelOf(cell) {
  const id = /\*\*([^*]+)\*\*/.exec(cell)?.[1]?.trim()
  if (!id) return undefined
  const over = /(?:^|[\s>])>\s*([\d.]+)\s*k\s+input tokens/i.exec(cell.replace(/<br\s*\/?>/g, " "))
  return { id, over: over ? Math.round(Number(over[1]) * 1000) : undefined }
}

/**
 * @param {string} markdown the pricing page's `.md` body
 * @returns {Map<string, import("./minimax-pricing-page.d.mts").MiniMaxPrice>}
 */
export function parseMiniMaxPricingPage(markdown) {
  const prices = new Map()
  const tiers = []
  const lines = markdown.split("\n")
  const start = lines.findIndex((l) => /^##\s+LLM\s*$/.test(l.trim()))
  if (start === -1) return prices

  let skipTab = false
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i].trim()
    if (/^##\s/.test(line)) break
    const tab = /^<Tab\s+title="([^"]*)"/.exec(line)
    if (tab) {
      skipTab = tab[1].trim().toLowerCase() !== "standard"
      continue
    }
    if (line.startsWith("</Tab>")) {
      skipTab = false
      continue
    }
    if (!line.startsWith("|") || skipTab) continue

    // A table: header row, separator, body rows.
    const titles = splitRow(line).map((t) => t.replace(/\*/g, "").toLowerCase())
    const col = (name) => titles.indexOf(name)
    const c = {
      model: col("model"),
      input: col("input"),
      output: col("output"),
      cacheRead: col("prompt caching read"),
      cacheWrite: col("prompt caching write"),
    }
    i += 2
    for (; i < lines.length && lines[i].trim().startsWith("|"); i++) {
      if (c.model === -1 || c.input === -1 || c.output === -1) continue
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
      else if (!prices.has(model.id)) prices.set(model.id, price)
    }
    i--
  }
  for (const { id, tier } of tiers) {
    const base = prices.get(id)
    if (!base) continue
    if (base.tiers?.some((t) => t.aboveInputTokens === tier.aboveInputTokens)) continue
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
export function checkMiniMaxPricingUsable(prices) {
  if (prices.size === 0) return "no priced rows parsed from the MiniMax pricing page"
  if (![...prices.keys()].some((id) => id.startsWith("MiniMax-"))) {
    return "no MiniMax-* model among the parsed rows"
  }
  return null
}

/**
 * GitHub Copilot's own per-token price list, parsed from the two source files
 * behind docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing
 * (github/docs, `main`):
 *
 *   - `data/tables/copilot/models-and-pricing.yml` - one block per model (and
 *     per prompt-length tier): input / cached_input / cache_write / output.
 *   - `content/copilot/reference/copilot-billing/models-and-pricing.md` - the
 *     promo footnotes (`[^mai-code-2-promo]`): "until <date>. Starting <date>,
 *     pricing is ...". The YAML carries only the price in force TODAY; the
 *     post-promo price lives only in these footnotes.
 *
 * This is the one machine-readable source that prices every model the
 * `copilot-cli` harness lists (MAI Code, the dotted Claude ids, Gemini, Grok,
 * Kimi...), at the rates Copilot bills. Plain JS so the bare-`node` sync script
 * and the TypeScript tests share it (types: `copilot-pricing-table.d.mts`).
 *
 * No YAML dependency: the file is a flat list of `- model:` blocks of
 * `key: value` lines, which `parseCopilotPricingYaml` reads directly.
 */

const round6 = n => Math.round(n * 1_000_000) / 1_000_000

const VENDORS = {
  openai: "openai",
  anthropic: "anthropic",
  google: "google",
  xai: "xai",
  microsoft: "microsoft",
  moonshot_ai: "moonshot",
}

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7,
  august: 8, september: 9, october: 10, november: 11, december: 12,
}

const unquote = s => s.trim().replace(/^'(.*)'$/s, "$1").replace(/^"(.*)"$/s, "$1")

/** `$0.025` -> 0.025; anything else ("Not applicable", "") -> undefined. */
function dollars(raw) {
  const m = /^\$\s*([0-9]+(?:\.[0-9]+)?)$/.exec((raw ?? "").trim())
  return m ? Number(m[1]) : undefined
}

/** `'> 272K'` -> 272000 (the tier starts above it); `'≤ 272K'` / absent -> undefined. */
function thresholdAbove(raw) {
  const m = /^>\s*([0-9]+(?:\.[0-9]+)?)\s*([KM])?$/i.exec((raw ?? "").trim())
  if (!m) return undefined
  const mult = m[2]?.toUpperCase() === "M" ? 1_000_000 : m[2] ? 1_000 : 1
  return Math.round(Number(m[1]) * mult)
}

/** `Claude Sonnet 5.5` -> `claude-sonnet-5.5` (Copilot's own id spelling). */
export function copilotModelId(displayName) {
  return displayName
    .replace(/\[\^[^\]]*\]/g, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
}

/** Flat `- key: value` YAML -> array of string maps. */
export function parseCopilotPricingYaml(yaml) {
  const blocks = []
  let cur
  for (const line of yaml.split("\n")) {
    if (/^\s*#/.test(line) || line.trim() === "") continue
    const start = /^-\s+(\w+):\s*(.*)$/.exec(line)
    if (start) {
      cur = { [start[1]]: unquote(start[2]) }
      blocks.push(cur)
      continue
    }
    const kv = /^\s+(\w+):\s*(.*)$/.exec(line)
    if (kv && cur) cur[kv[1]] = unquote(kv[2])
  }
  return blocks
}

function isoDate(text) {
  const m = /([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/.exec(text)
  const month = m && MONTHS[m[1].toLowerCase()]
  if (!month) return undefined
  return `${m[3]}-${String(month).padStart(2, "0")}-${String(Number(m[2])).padStart(2, "0")}`
}

/**
 * Promo footnotes of the .md page -> Map<footnote id, { until, then? }>.
 * `then` (the standard price after the promo) is only present when the
 * footnote states it ("Starting <date>, pricing is $X per 1M input tokens,
 * $Y per 1M cached input tokens, and $Z per 1M output tokens").
 */
export function parseCopilotPromoFootnotes(markdown) {
  const out = new Map()
  for (const line of markdown.split("\n")) {
    const head = /^\[\^([\w-]+)\]:\s*(.*)$/.exec(line)
    if (!head) continue
    const body = head[2]
    const until = /(?:until|through)\s+([A-Za-z]+\s+\d{1,2},\s*\d{4})/.exec(body)
    if (!until || !/promotional/i.test(body)) continue
    const entry = { until: isoDate(until[1]) }
    const after = /Starting\s+[A-Za-z]+\s+\d{1,2},\s*\d{4},\s*pricing is\s+(.*)$/.exec(body)
    if (after) {
      const grab = re => {
        const m = re.exec(after[1])
        return m ? Number(m[1]) : undefined
      }
      const input = grab(/\$([0-9.]+) per 1M input/)
      const cached = grab(/\$([0-9.]+) per 1M cached input/)
      const output = grab(/\$([0-9.]+) per 1M output/)
      if (input !== undefined && output !== undefined) {
        entry.then = { inputPer1M: input, outputPer1M: output }
        if (cached !== undefined && input > 0) entry.then.cacheReadMultiplier = round6(cached / input)
      }
    }
    out.set(head[1], entry)
  }
  return out
}

/**
 * Combine the table and the footnotes into `Map<copilot model id, price>`.
 * Rows of one model with a `> N` threshold become `tiers`. Display names with
 * a parenthesised qualifier ("... (fast mode) (preview)") are not Copilot
 * model ids and are skipped.
 *
 * price = { inputPer1M, outputPer1M, cacheReadMultiplier?, cacheWriteMultiplier?,
 *           tiers?, vendor, promo?: { until, then? } }
 */
export function parseCopilotPricing(yaml, markdown = "") {
  const footnotes = parseCopilotPromoFootnotes(markdown)
  const prices = new Map()
  for (const row of parseCopilotPricingYaml(yaml)) {
    if (!row.model || /\(/.test(row.model.replace(/\[\^[^\]]*\]/g, ""))) continue
    const id = copilotModelId(row.model)
    const input = dollars(row.input)
    const output = dollars(row.output)
    if (!id || input === undefined || output === undefined) continue
    const cached = dollars(row.cached_input)
    const write = dollars(row.cache_write)
    const price = { inputPer1M: input, outputPer1M: output }
    if (cached !== undefined && input > 0) price.cacheReadMultiplier = round6(cached / input)
    if (write !== undefined && input > 0) price.cacheWriteMultiplier = round6(write / input)
    const vendor = VENDORS[row.provider]
    if (vendor) price.vendor = vendor
    const above = thresholdAbove(row.threshold)
    if (above !== undefined) {
      const base = prices.get(id)
      if (!base) continue
      const tier = { aboveInputTokens: above, inputPer1M: input, outputPer1M: output }
      if (price.cacheReadMultiplier !== undefined) tier.cacheReadMultiplier = price.cacheReadMultiplier
      if (price.cacheWriteMultiplier !== undefined) tier.cacheWriteMultiplier = price.cacheWriteMultiplier
      base.tiers = [...(base.tiers ?? []), tier]
      continue
    }
    if (prices.has(id)) continue
    const note = /\[\^([\w-]+)\]/.exec(row.model)
    const promo = note && footnotes.get(note[1])
    if (promo?.until) price.promo = promo
    prices.set(id, price)
  }
  return prices
}

/** null when the parse looks right, else the reason it is unusable. */
export function checkCopilotPricingUsable(prices) {
  if (prices.size < 10) return `only ${prices.size} priced rows parsed from the Copilot pricing table (expected 10+)`
  if (![...prices.keys()].some(id => id.startsWith("mai-code-"))) {
    return "no mai-code-* row in the Copilot pricing table (layout change?)"
  }
  return null
}

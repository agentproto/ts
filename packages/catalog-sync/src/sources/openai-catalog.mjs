/**
 * Pure merge logic for the native OpenAI LLM catalog.
 *
 * Three inputs, each independently optional, combined into one row set:
 *
 *   1. **ids** — `GET https://api.openai.com/v1/models` (needs `OPENAI_API_KEY`).
 *      The authoritative statement of "which model ids exist". Carries NO
 *      price and NO context window, only `{id, created, owned_by}`.
 *   2. **official prices** — `GET https://platform.openai.com/docs/pricing.md`
 *      (no auth). OpenAI's docs site serves a Markdown rendering of any docs
 *      page when you append `.md`, and advertises this on the page itself
 *      ("Markdown versions of documentation pages are available by appending
 *      `.md` to the page URL"). Content-type is `text/markdown` and the
 *      prices are GFM pipe tables with a labelled header row — so this is
 *      parsed by COLUMN NAME, never by column position, and never by
 *      scraping the HTML page's DOM. See {@link parseOpenAiDocsPricing}.
 *   3. **OpenRouter prices** — `GET https://openrouter.ai/api/v1/models`
 *      filtered to `openai/*` (no auth). The historical source for both ids
 *      and prices; now the fallback for prices and a supplementary id source.
 *
 * Every function here is pure: no `fetch`, no `process.env`, no filesystem.
 * `scripts/catalog-sync/sync-openai.mjs` does the I/O and calls in here, and
 * `packages/catalog-sync/src/__tests__/openai-catalog.test.ts` tests the
 * logic without a network. Plain `.mjs` (with a hand-written `.d.mts`) for
 * the same reason `generators/google-native-model-ids.mjs` is: the sync
 * script is bare `node` with no TS toolchain, and a second copy of this
 * logic living in the script would silently drift from the tested one.
 */

/**
 * Ids this LLM catalog does not carry. Speech, image, video, embeddings,
 * moderation, realtime voice and legacy base-completion families are either
 * represented in a sibling modality catalog (`model-catalog/src/{audio,image,
 * video}/catalog.ts`, keyed by `providerId`) or nowhere at all — none of them
 * belong in `LLM_PRICING_CATALOG`.
 *
 * Token-anchored rather than dash-bounded because OpenAI ids are not
 * dash-segmented (`whisper-1`, `tts-1-hd`, `text-embedding-3-small` have no
 * trailing dash after the family token).
 *
 * `-image-\d` specifically excludes versioned image-output multimodal
 * variants (e.g. `gpt-5.4-image-2`) that OpenRouter carries with standard
 * prompt/completion pricing but this catalog has never treated as
 * first-party-routable products — only the two already-curated exceptions
 * (`gpt-5-image`, `gpt-5-image-mini`, no digit after "image") stay
 * includable; see `packages/runtime/src/__tests__/spawn-model-eligibility.test.ts`
 * for the route-eligibility assumption this protects.
 *
 * `sora|gpt-live|babbage|davinci` were added when `/v1/models` became an id
 * source: OpenRouter never carried those families under `openai/*`, so the
 * OpenRouter-only version of this filter never needed to name them. They are
 * `sora-2` / `sora-2-pro` (video), `gpt-live-1` (voice sessions billed per
 * MINUTE, not per token — no per-1M row can represent it), and `babbage-002`
 * / `davinci-002` (legacy base-completion models, outside the chat/reasoning/
 * codex families this catalog covers).
 *
 * `gpt-audio*` is deliberately NOT excluded: those are Chat Completions
 * models with per-1M token pricing, they are already carried here, and
 * unlike `tts-*`/`whisper-1`/`gpt-realtime-*` they have no row in
 * `model-catalog/src/audio/catalog.ts` — excluding them would delete them
 * from the catalog entirely rather than move them.
 */
export const OPENAI_NON_LLM_ID_REGEX =
  /embed|moderation|whisper|tts|dall-e|realtime|transcribe|ocr|gpt-image|-image-\d|sora|gpt-live|babbage|davinci/i

/**
 * Ids that are real but too generic to be a PRICING key, because
 * `resolvePricing` falls back to a substring scan (`modelId.includes(key)`
 * over every catalog key — `model-catalog/src/llm/catalog.ts`). A bare
 * `chat-latest` row would be a substring of `gpt-5-chat-latest`,
 * `gpt-5.3-chat-latest`, `gpt-chat-latest` … and, sorting first within the
 * OpenAI block, would win the scan for all of them — silently repricing
 * `gpt-5-chat-latest` from gpt-5's $1.25/$10 to chat-latest's $5.00/$30.00.
 *
 * Such an id still EXISTS (it ships in `OPENAI_GENERATED_UNPRICED_IDS`, so
 * `isKnownLlmId` answers true); it just does not get a pricing row, which is
 * the one thing that would corrupt other ids' costs.
 */
export const AMBIGUOUS_BARE_IDS = new Set(["chat-latest"])

/** True for ids this catalog carries as chat/reasoning/codex LLM rows. */
export function isOpenAiLlmId(id) {
  return typeof id === "string" && id.length > 0 && !OPENAI_NON_LLM_ID_REGEX.test(id)
}

/** Round to 6 decimal places (matches sync-anthropic.mjs / sync-google.mjs
 *  precision — cache-multiplier ratios need more than 4 decimals). */
export function round6(num) {
  return Math.round(num * 1_000_000) / 1_000_000
}

// ── Official pricing: platform.openai.com/docs/pricing.md ──────────────────

/**
 * Tier labels the docs page uses to separate otherwise-identical tables.
 * They appear either as an explicit `### <Tier> pricing data` heading or as a
 * bare line above a generically-titled `### Grouped Pricing Table data`.
 * Only `standard` and `batch` are consumed; `flex` and `fast` are recognised
 * purely so their tables are attributed to them and NOT mistaken for the
 * standard rate.
 */
const TIER_LABELS = {
  standard: "standard",
  batch: "batch",
  flex: "flex",
  fast: "fast",
  "fast mode": "fast",
  priority: "fast",
}

/** `| a | b |` → `["a", "b"]`; returns null for a non-table line. */
function splitRow(line) {
  const trimmed = line.trim()
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return null
  return trimmed
    .slice(1, -1)
    .split("|")
    .map((cell) => cell.trim())
}

/** True for the `| --- | --- |` separator under a Markdown table header. */
function isSeparatorRow(cells) {
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell))
}

/**
 * `"$1.75"` → `1.75`; `"-"`, `""`, `"Free"`, `"$100.00 / hour"` → null.
 * Anything that is not a plain dollar amount is refused rather than coerced,
 * so a unit change on the page (per-minute, per-image, per-1k-calls) drops
 * the row instead of silently mis-pricing it by a factor of a million.
 */
export function parseDollars(cell) {
  if (typeof cell !== "string") return null
  const match = /^\$([0-9]+(?:\.[0-9]+)?)$/.exec(cell.trim())
  if (!match) return null
  const value = Number.parseFloat(match[1])
  return Number.isFinite(value) ? value : null
}

/**
 * Strip the parenthetical qualifiers the docs tables append to a model label
 * — `gpt-5.5 (<272K context length)`, `gpt-3.5-turbo (legacy)`,
 * `o4-mini-2025-04-16 (data sharing)`. A label that still contains anything
 * other than an id-shaped token afterwards is rejected by the caller.
 */
function cleanModelLabel(cell) {
  return cell
    .replace(/`/g, "")
    .replace(/\s*\([^)]*\)\s*/g, " ")
    .trim()
}

/** Ids are lowercase alphanumerics with dots/dashes/slashes/colons. */
function isIdShaped(label) {
  return /^[a-z0-9][a-z0-9._:/-]*$/.test(label)
}

/**
 * Locate the columns we understand, by NAME. Returns null when the table is
 * not a per-1M-token price table we can read.
 *
 * Accepted: a `Model` column, an input column and an output column, where
 * input/output may carry the `Short context ` prefix the flagship tables use.
 * The `Long context ` columns are deliberately NOT matched — the catalog
 * holds one rate per id and it is the base (short-context) rate, same as the
 * single rate OpenRouter publishes.
 *
 * Rejected outright: any table with a `Training` column (the fine-tuning
 * tables reuse the SAME base-model ids at fine-tuned rates — `gpt-4.1-2025-04-14`
 * appears there at $3.00 input against $2.00 standard), and any table with a
 * `Modality` column (the realtime/audio tables emit one row per modality).
 */
function readHeader(cells) {
  const names = cells.map((cell) => cell.toLowerCase().trim())
  if (names.some((name) => name === "training" || name === "modality")) return null

  const find = (re) => {
    const index = names.findIndex((name) => re.test(name))
    return index === -1 ? null : index
  }

  const model = find(/^model$/)
  const input = find(/^(short context )?input$/)
  const output = find(/^(short context )?output$/)
  if (model === null || input === null || output === null) return null

  return {
    model,
    input,
    output,
    cachedInput: find(/^(short context )?cached input$/),
    cacheWrites: find(/^(short context )?cache writes$/),
  }
}

/**
 * Parse `platform.openai.com/docs/pricing.md` into per-tier price maps.
 *
 * Returns `{ standard, batch }`, each a `Map<id, OfficialPrice>` with prices
 * in USD per 1M tokens. Unknown tiers, unreadable tables and unparseable
 * rows are skipped silently — the CALLER is responsible for sanity-checking
 * the result size before trusting it (see {@link checkOfficialPricingUsable}),
 * because "the page changed shape" must degrade to the OpenRouter fallback,
 * never to a catalog of wrong numbers.
 */
export function parseOpenAiDocsPricing(markdown) {
  const standard = new Map()
  const batch = new Map()
  if (typeof markdown !== "string") return { standard, batch }

  let tier = null
  /** null = between tables; "rejected" = inside a table we cannot read. */
  let header = null
  const lines = markdown.split(/\r?\n/)

  for (const line of lines) {
    const cells = splitRow(line)

    if (!cells) {
      // Not a table row — it may however be a tier label or a heading.
      header = null
      const heading = /^#{1,6}\s+(.*?)\s+pricing data\s*$/i.exec(line)
      const label = (heading ? heading[1] : line).trim().toLowerCase()
      if (Object.hasOwn(TIER_LABELS, label)) tier = TIER_LABELS[label]
      continue
    }

    if (isSeparatorRow(cells)) continue

    if (header === null) {
      header = readHeader(cells) ?? "rejected"
      continue
    }
    if (header === "rejected") continue

    const target = tier === "standard" ? standard : tier === "batch" ? batch : null
    if (!target) continue

    const id = cleanModelLabel(cells[header.model] ?? "")
    if (!isIdShaped(id) || target.has(id)) continue

    const inputPer1M = parseDollars(cells[header.input])
    const outputPer1M = parseDollars(cells[header.output])
    if (inputPer1M === null || outputPer1M === null) continue

    target.set(id, {
      inputPer1M,
      outputPer1M,
      cachedInputPer1M:
        header.cachedInput === null ? null : parseDollars(cells[header.cachedInput]),
      cacheWritePer1M:
        header.cacheWrites === null ? null : parseDollars(cells[header.cacheWrites]),
    })
  }

  return { standard, batch }
}

/**
 * Ids that must be present in a parse of the docs pricing page for it to be
 * believable. Deliberately a handful of long-lived, widely-referenced ids
 * rather than the newest family: a page restructure that drops `gpt-4o` and
 * `gpt-4.1` from the standard table is a parser break, not a price change.
 */
export const OFFICIAL_PRICING_SENTINEL_IDS = ["gpt-4o", "gpt-4.1", "gpt-5", "gpt-5-mini"]

/** Minimum standard-tier rows a believable parse yields. The live page has
 *  had 35+ for its entire observed history; 12 is a floor, not a target. */
export const OFFICIAL_PRICING_MIN_ROWS = 12

/**
 * Decide whether a parse of the docs page is trustworthy enough to price the
 * catalog from. Returns `null` when it is, or a human-readable reason when it
 * is not — in which case the caller falls back to OpenRouter for every row
 * and says so in the generated file's banner.
 */
export function checkOfficialPricingUsable(parsed) {
  const standard = parsed?.standard
  if (!standard || standard.size === 0) {
    return "no standard-tier rows parsed from the docs pricing page"
  }
  if (standard.size < OFFICIAL_PRICING_MIN_ROWS) {
    return `only ${standard.size} standard-tier rows parsed (expected >= ${OFFICIAL_PRICING_MIN_ROWS})`
  }
  const missing = OFFICIAL_PRICING_SENTINEL_IDS.filter((id) => !standard.has(id))
  if (missing.length > 0) {
    return `docs pricing page parsed without sentinel ids: ${missing.join(", ")}`
  }
  return null
}

// ── OpenRouter passthrough prices ──────────────────────────────────────────

/**
 * `openrouter.ai/api/v1/models` → `Map<bare id, price>` for `openai/*` routes.
 * OpenRouter quotes USD per token, so every figure is scaled by 1e6.
 * `cacheReadMultiplier` / `cacheWriteMultiplier` are ratios against the
 * route's own prompt price, the same derivation sync-anthropic.mjs and
 * sync-google.mjs use.
 */
export function buildOpenRouterPriceMap(models) {
  const map = new Map()
  for (const model of models ?? []) {
    if (!model?.id?.startsWith("openai/")) continue
    if (!model.pricing?.prompt || !model.pricing?.completion) continue

    const id = model.id.replace(/^openai\//, "")
    const promptPerToken = Number.parseFloat(model.pricing.prompt)
    const completionPerToken = Number.parseFloat(model.pricing.completion)
    if (!Number.isFinite(promptPerToken) || !Number.isFinite(completionPerToken)) continue

    const entry = {
      inputPer1M: round6(promptPerToken * 1e6),
      outputPer1M: round6(completionPerToken * 1e6),
    }
    if (model.pricing.input_cache_read && promptPerToken > 0) {
      const ratio = Number.parseFloat(model.pricing.input_cache_read) / promptPerToken
      if (Number.isFinite(ratio)) entry.cacheReadMultiplier = round6(ratio)
    }
    if (model.pricing.input_cache_write && promptPerToken > 0) {
      const ratio = Number.parseFloat(model.pricing.input_cache_write) / promptPerToken
      if (Number.isFinite(ratio)) entry.cacheWriteMultiplier = round6(ratio)
    }
    map.set(id, entry)
  }
  return map
}

// ── Merge ──────────────────────────────────────────────────────────────────

/**
 * Official price for an id, or null.
 *
 * `<base>:batch` is OpenRouter's spelling for OpenAI's Batch API surface;
 * `/v1/models` has no such id because Batch is a different endpoint, not a
 * different model. The docs page prices it in its own Batch table under the
 * BASE id, so a `:batch` row is priced officially by stripping the suffix and
 * reading that table — which is strictly better than the OpenRouter rate for
 * the same surface.
 */
export function lookupOfficialPrice(id, official) {
  if (!official) return null
  const isBatch = id.endsWith(":batch")
  const table = isBatch ? official.batch : official.standard
  const key = isBatch ? id.slice(0, -":batch".length) : id
  const row = table?.get(key)
  if (!row) return null

  const entry = { inputPer1M: round6(row.inputPer1M), outputPer1M: round6(row.outputPer1M) }
  if (row.cachedInputPer1M !== null && row.cachedInputPer1M !== undefined && row.inputPer1M > 0) {
    entry.cacheReadMultiplier = round6(row.cachedInputPer1M / row.inputPer1M)
  }
  if (row.cacheWritePer1M !== null && row.cacheWritePer1M !== undefined && row.inputPer1M > 0) {
    entry.cacheWriteMultiplier = round6(row.cacheWritePer1M / row.inputPer1M)
  }
  return entry
}

/**
 * Combine the three sources into the rows the generated file carries.
 *
 * **Ids.** When `openAiIds` is provided it is authoritative: every LLM-shaped
 * id OpenAI lists appears, priced or not. OpenRouter ids that `/v1/models`
 * does NOT list are KEPT rather than dropped, flagged `idSource:
 * "openrouter"` — `/v1/models` is scoped to the calling ACCOUNT's access, not
 * a global product catalog, and the OpenRouter-only set is dominated by ids
 * that are real but structurally absent from it: `<base>:batch` (a separate
 * endpoint, never a listed model), `gpt-oss-*` (open-weights, not served by
 * OpenAI's API at all), and tier/family variants a given account has no
 * entitlement to. Dropping them would make the catalog a function of whose
 * key CI happens to hold. When `openAiIds` is null (no key), behaviour is
 * exactly the historical one: OpenRouter is the sole id source.
 *
 * **Prices.** Official first, OpenRouter as the per-row fallback, recorded
 * per row as `priceSource`. An id neither source prices — or one held back by
 * {@link AMBIGUOUS_BARE_IDS} — is NOT given a fabricated zero; it is returned
 * in `unpricedIds` for the generated file to emit as an existence-only entry
 * (see `LlmModelId` / `isKnownLlmId` in `model-catalog/src/llm/catalog.ts`:
 * membership and pricing are independent questions by design).
 */
export function mergeOpenAiCatalog({ openAiIds, openRouterPrices, officialPricing }) {
  const nativeIds = openAiIds === null || openAiIds === undefined ? null : new Set(openAiIds)
  const orPrices = openRouterPrices ?? new Map()

  const candidates = new Set()
  if (nativeIds) for (const id of nativeIds) candidates.add(id)
  for (const id of orPrices.keys()) candidates.add(id)

  const entries = []
  const unpricedIds = []

  for (const id of [...candidates].sort((a, b) => a.localeCompare(b))) {
    if (!isOpenAiLlmId(id)) continue

    const idSource = nativeIds ? (nativeIds.has(id) ? "openai" : "openrouter") : "openrouter"
    const official = lookupOfficialPrice(id, officialPricing)
    const price = AMBIGUOUS_BARE_IDS.has(id) ? null : (official ?? orPrices.get(id) ?? null)

    if (!price) {
      unpricedIds.push(id)
      continue
    }

    entries.push({
      id,
      inputPer1M: price.inputPer1M,
      outputPer1M: price.outputPer1M,
      ...(price.cacheReadMultiplier === undefined
        ? {}
        : { cacheReadMultiplier: price.cacheReadMultiplier }),
      ...(price.cacheWriteMultiplier === undefined
        ? {}
        : { cacheWriteMultiplier: price.cacheWriteMultiplier }),
      priceSource: official ? "openai" : "openrouter",
      idSource,
    })
  }

  return { entries, unpricedIds }
}

// ── Rendering ──────────────────────────────────────────────────────────────

/** Serialize one merged row as a `LLMPricing` object literal. */
export function renderEntry(entry) {
  const parts = [`inputPer1M: ${entry.inputPer1M}`, `outputPer1M: ${entry.outputPer1M}`]
  if (entry.cacheReadMultiplier !== undefined) {
    parts.push(`cacheReadMultiplier: ${entry.cacheReadMultiplier}`)
  }
  if (entry.cacheWriteMultiplier !== undefined) {
    parts.push(`cacheWriteMultiplier: ${entry.cacheWriteMultiplier}`)
  }
  parts.push(`vendor: "openai"`, `provider: "openai"`)
  parts.push(`priceSource: ${JSON.stringify(entry.priceSource)}`)
  parts.push(`idSource: ${JSON.stringify(entry.idSource)}`)
  return `  ${JSON.stringify(entry.id)}: { ${parts.join(", ")} },`
}

/**
 * Render the whole `openai-pricing.generated.ts` file body.
 *
 * `idSourceLabel` / `priceSourceLabel` describe what actually happened on
 * THIS run so the committed file is self-describing: a run without
 * `OPENAI_API_KEY`, or one where the docs page failed its sanity check, says
 * so in its own banner rather than claiming a provenance it does not have.
 */
export function renderGeneratedFile({
  entries,
  unpricedIds,
  syncedAt,
  idSourceLabel,
  priceSourceLabel,
  officialPricingNote,
}) {
  const banner =
    `// GENERATED FILE — do not edit; regenerate with scripts/catalog-sync/sync-openai.mjs\n` +
    `// (ids: ${idSourceLabel}; prices: ${priceSourceLabel}; synced ${syncedAt})\n` +
    `//\n` +
    `// Provenance is recorded PER ROW — \`idSource\` says which list the id came\n` +
    `// from, \`priceSource\` which source priced it:\n` +
    `//   idSource "openai"     — listed by GET api.openai.com/v1/models\n` +
    `//   idSource "openrouter" — only on openrouter.ai/api/v1/models under openai/*.\n` +
    `//                           Kept, not dropped: /v1/models is scoped to the\n` +
    `//                           calling account, and this set is mostly ids that\n` +
    `//                           cannot appear there at all (\`:batch\` is a separate\n` +
    `//                           endpoint; \`gpt-oss-*\` is open-weights).\n` +
    `//   priceSource "openai"     — platform.openai.com/docs/pricing.md, OpenAI's\n` +
    `//                              own Markdown rendering of the pricing page,\n` +
    `//                              parsed by column NAME from its GFM tables.\n` +
    `//                              Short-context standard rate; \`:batch\` rows are\n` +
    `//                              priced from that page's Batch table.\n` +
    `//   priceSource "openrouter" — OpenRouter's passthrough rate, which may differ\n` +
    `//                              from OpenAI's first-party pricing.\n` +
    (officialPricingNote ? `//\n${officialPricingNote}` : "") +
    `\n`

  const body = entries.map(renderEntry).join("\n")
  const unpriced = unpricedIds.map((id) => `  ${JSON.stringify(id)},`).join("\n")

  const unpricedBanner =
    `\n/**\n` +
    ` * OpenAI-listed ids with NO price from either source — emitted as\n` +
    ` * existence-only so they are real members of \`LlmModelId\` and answer true\n` +
    ` * to \`isKnownLlmId\`, without a fabricated zero in \`LLM_PRICING_CATALOG\`.\n` +
    ` * "Does this model exist" and "what does it cost" are independent questions\n` +
    ` * in this catalog by design — see \`LlmModelId\`'s doc comment. Most of these\n` +
    ` * are dated snapshots (\`gpt-5.4-2026-03-05\`) and aliases the docs pricing\n` +
    ` * page lists only under their undated base id; deriving a price from that\n` +
    ` * base would be inference, not data, so it is not done.\n` +
    ` *\n` +
    ` * \`chat-latest\` is here for a different reason — it IS officially priced,\n` +
    ` * but a bare key that generic would win \`resolvePricing\`'s substring scan\n` +
    ` * against every \`*-chat-latest\` id and reprice them. See\n` +
    ` * \`AMBIGUOUS_BARE_IDS\` in catalog-sync's \`sources/openai-catalog.mjs\`.\n` +
    ` */\n`

  // `{\n\n}` / `[\n\n]` would be a syntax-valid but ugly empty literal.
  //
  // The empty ARRAY must stay `as const` (i.e. `readonly []`, whose `[number]`
  // is `never`) and must NOT be annotated `readonly string[]`: `LlmModelId`
  // unions in `(typeof OPENAI_GENERATED_UNPRICED_IDS)[number]`, and
  // `(readonly string[])[number]` is plain `string` — which would silently
  // widen the whole union to `string` and switch off every id typo check in
  // the repo. The empty branch is reachable on any run without
  // `OPENAI_API_KEY` (no native ids ⇒ nothing unpriced), so it is a live
  // path, not a theoretical one.
  const pricingLiteral = body === "" ? "{} as const" : `{\n${body}\n} as const`
  const unpricedLiteral = unpriced === "" ? "[] as const" : `[\n${unpriced}\n] as const`

  return (
    `${banner}export const OPENAI_GENERATED_PRICING = ${pricingLiteral}\n` +
    `${unpricedBanner}export const OPENAI_GENERATED_UNPRICED_IDS = ${unpricedLiteral}\n`
  )
}

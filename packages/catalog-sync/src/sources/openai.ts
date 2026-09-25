/**
 * OpenAI LLM source contract.
 *
 * This source used to be `refreshable: false`, on the stated grounds that
 * "OpenAI does not publish a stable, machine-readable pricing/model catalog
 * endpoint". That was two claims, and both have an answer:
 *
 *   - **Ids.** `GET https://api.openai.com/v1/models` is authoritative and
 *     always existed. It carries no price and no context window — which is
 *     why it cannot be the only source, not a reason to ignore it. Needs
 *     `OPENAI_API_KEY`; its absence degrades to OpenRouter ids, never to a
 *     failure.
 *   - **Prices.** `https://platform.openai.com/docs/pricing.md` is OpenAI's
 *     own Markdown rendering of the pricing page — `text/markdown`, GFM pipe
 *     tables with labelled header rows, and advertised on the page itself
 *     ("Markdown versions of documentation pages are available by appending
 *     `.md` to the page URL"). It is still docs, not a versioned API, so the
 *     parser reads columns by NAME and the result is sanity-checked before
 *     use (`checkOfficialPricingUsable`); a page restructure falls back to
 *     OpenRouter's passthrough rate rather than emitting wrong numbers.
 *
 * We still do NOT scrape the HTML pricing page's DOM, and still do not guess.
 * Rows OpenAI does not price stay unpriced (`OPENAI_GENERATED_UNPRICED_IDS`)
 * instead of getting a fabricated zero.
 *
 * The implementation lives in `./openai-catalog.mjs` (pure, tested) and
 * `scripts/catalog-sync/sync-openai.mjs` (the I/O), rather than in a
 * `defineGenerator` generator, because the per-vendor `sync-*.mjs` family is
 * what writes the native `*-pricing.generated.ts` files; the weekly workflow
 * runs both halves.
 */

import type { RefreshableSource } from "../refresh-workflow.js"

/** Ids: OpenAI's own models list. Authed; skipped when the key is absent. */
export const OPENAI_MODELS_SOURCE: RefreshableSource = {
  source: {
    id: "llm-openai",
    url: "https://api.openai.com/v1/models",
    headers: { Authorization: "Bearer env:OPENAI_API_KEY" },
  },
  refreshable: true,
  notes:
    "Authoritative OpenAI model id list. Carries no pricing and no context " +
    "window, so it is merged with a price source rather than used alone. " +
    "Without OPENAI_API_KEY the sync falls back to OpenRouter's openai/* ids.",
}

/** Prices: OpenAI's published pricing page, in its Markdown rendering. */
export const OPENAI_PRICING_SOURCE: RefreshableSource = {
  source: {
    id: "llm-openai-pricing",
    url: "https://platform.openai.com/docs/pricing.md",
  },
  refreshable: true,
  notes:
    "OpenAI's own Markdown rendering of the pricing page (text/markdown, GFM " +
    "tables). Parsed by column name and sanity-checked before use; on a page " +
    "restructure the sync falls back to OpenRouter passthrough rates and says " +
    "so in the generated file's banner.",
}

/**
 * Back-compat alias. Historically the single OpenAI source; now the id half,
 * since that is the one this catalog treats as authoritative.
 */
export const OPENAI_LLM_SOURCE: RefreshableSource = OPENAI_MODELS_SOURCE

/** Convenience array for workflows that want to include the OpenAI contract. */
export const OPENAI_SOURCES: RefreshableSource[] = [
  OPENAI_MODELS_SOURCE,
  OPENAI_PRICING_SOURCE,
]

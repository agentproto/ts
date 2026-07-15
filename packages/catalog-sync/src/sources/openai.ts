/**
 * OpenAI LLM source contract.
 *
 * OpenAI does **not** publish a stable, machine-readable pricing/model catalog
 * endpoint. The authoritative pricing page is `openai.com/api/pricing`, but it
 * is HTML-only, not a documented API, and has historically changed layout
 * without notice.
 *
 * Therefore this source is intentionally **not refreshable** in the automated
 * `catalog-sync` workflow. Pricing is committed by hand from the official page
 * and cross-checked with third-party aggregators where noted. We do not scrape
 * or guess.
 *
 * If OpenAI releases a stable `/v1/models` endpoint that includes pricing, or
 * a documented pricing JSON feed, this source can be upgraded to refreshable.
 * Until then, the gap is recorded honestly in refresh results.
 */

import type { RefreshableSource } from "../refresh-workflow.js"

export const OPENAI_LLM_SOURCE: RefreshableSource = {
  source: {
    id: "llm-openai",
    url: "https://openai.com/api/pricing",
  },
  refreshable: false,
  notes:
    "OpenAI has no stable machine-readable pricing endpoint. " +
    "Pricing in @agentproto/model-catalog is committed manually from " +
    "openai.com/api/pricing and verified against independent aggregators " +
    "where possible. Automated refresh is disabled to avoid scraping or " +
    "fabricating prices.",
}

/** Convenience array for workflows that want to include the OpenAI contract. */
export const OPENAI_SOURCES: RefreshableSource[] = [OPENAI_LLM_SOURCE]

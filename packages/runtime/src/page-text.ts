/**
 * Turn raw fetched/rendered HTML into clean reading material for an agent —
 * shared by `fetch_page` (plain HTTP) and `browser_extract_text` (a
 * chrome-live owned tab's DOM). Deterministic, no LLM, no network beyond
 * what the caller already did.
 *
 * Mirrors `@agentproto/bureau-purify`'s `purify()` (same Defuddle call, same
 * `{ title, markdown }` shape) rather than depending on it: bureau is a
 * downstream product with its own release/publish cadence, and this is a
 * small enough wrapper that duplicating it keeps the daemon's core runtime
 * from depending on a product package three repos should never cross.
 */
import { Defuddle } from "defuddle/node"

export interface PageText {
  /** The article/page title Defuddle resolved (may be empty). */
  readonly title: string
  /** The main content as Markdown, boilerplate stripped. */
  readonly text: string
}

/**
 * @param html raw HTML (fetched or rendered — full page, nav/ads and all).
 * @param url  source URL — Defuddle uses it to resolve relative links.
 * @throws if `html` is empty or Defuddle cannot parse the document.
 */
export async function extractPageText(html: string, url: string): Promise<PageText> {
  if (!html.trim()) throw new Error("extractPageText: html is empty")
  const result = await Defuddle(html, url, { markdown: true })
  return {
    title: (result.title ?? "").trim(),
    text: (result.content ?? "").trim(),
  }
}

/**
 * Anti-bot CHALLENGE-PAGE fingerprints — narrower than
 * `@agentproto/bureau-router`'s `detectSignals` on purpose. That router
 * scores "blocked" as one signal among several feeding a weighted escalation
 * decision; `fetch_page` uses it as a hard gate that drops `text` entirely,
 * so a false positive is much costlier here. Every pattern below is a
 * challenge-platform-specific marker (script path, cookie/class name, or the
 * exact Cloudflare interstitial phrase) — deliberately NOT the broader
 * vendor-name/generic-copy matches bureau's router uses (`/cdn-cgi/` alone
 * appears on ordinary Cloudflare-fronted pages via email-obfuscation and
 * Rocket Loader; "akamai"/"access denied"/"are you a robot" appear in
 * ordinary articles about bot detection). A normal 200 page must never trip
 * this.
 */
const BLOCK_FINGERPRINTS: RegExp[] = [
  /cf-browser-verification|cf_chl_|__cf_chl_rt_tk|chl_page|cdn-cgi\/challenge-platform|just a moment\.\.\./i, // cloudflare
  /incap_ses_|_incapsula_resource/i, // imperva/incapsula
  /px-captcha|_pxCaptcha/i, // perimeterx
  /captcha-delivery\.com/i, // datadome
  /ak_bmsc=/i, // akamai bot manager (cookie)
]

const BLOCKED_STATUSES = new Set([401, 403, 407, 429, 503])

/** True when a plain HTTP fetch of this status/body looks anti-bot-blocked
 *  rather than genuinely missing/erroring — the signal `fetch_page` uses to
 *  tell its caller "escalate to a real browser" instead of a generic fetch
 *  failure. */
export function looksBlocked(status: number, html: string): boolean {
  if (BLOCKED_STATUSES.has(status)) return true
  return BLOCK_FINGERPRINTS.some((re) => re.test(html))
}

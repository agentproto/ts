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

/** Anti-bot vendor fingerprints in challenge-page bodies — the same signals
 *  `@agentproto/bureau-router` detects, trimmed to what `fetch_page` needs:
 *  just "is this tier blocked", not the router's full escalation signal set
 *  (empty_body / spa_shell / missing_field don't apply to a single read). */
const BLOCK_FINGERPRINTS: RegExp[] = [
  /cf-browser-verification|cf-challenge|\/cdn-cgi\/|just a moment\.\.\./i, // cloudflare
  /_incapsula_|incap_ses_|x-iinfo/i, // imperva/incapsula
  /perimeterx|_px(2|3)?=|px-captcha/i, // perimeterx
  /datadome|dd_cookie|x-datadome/i, // datadome
  /ak_bmsc|akamai|reference #\d+\.\w+/i, // akamai
  /attention required|access denied|are you a robot/i, // generic challenge copy
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

/**
 * HttpReadabilityFetcher — a browser-free FetcherPort for articles:
 * plain `fetch` + a lightweight readability extraction (prefer
 * <article>/<main>, strip chrome). Validated to pull ~35k chars from a
 * real corpus article. Returns `null` for non-HTML or empty bodies so a
 * video or authed-browser fetcher can take those.
 *
 * No JS execution — so it won't get SPA-only content; for login-walled
 * or JS-rendered pages, compose a BrowserMcpFetcher ahead of/after this.
 */

import type { FetcherPort, FetchedSource } from "@agentproto/corpus"
import { isVideoUrl } from "./video-hosts.js"

export interface HttpReadabilityFetcherOptions {
  readonly userAgent?: string
  readonly maxChars?: number
}

const DEFAULT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0 Safari/537.36"

export class HttpReadabilityFetcher implements FetcherPort {
  private readonly ua: string
  private readonly maxChars: number

  constructor(opts: HttpReadabilityFetcherOptions = {}) {
    this.ua = opts.userAgent ?? DEFAULT_UA
    this.maxChars = opts.maxChars ?? 200_000
  }

  async fetch(url: string): Promise<FetchedSource | null> {
    // Video URLs belong to the transcription fetcher. Never scrape a
    // watch page here — a failed transcription must skip, not fall
    // through to YouTube's page chrome.
    if (isVideoUrl(url)) return null

    let res: Response
    try {
      res = await fetch(url, {
        headers: { "user-agent": this.ua, "accept-language": "en,fr;q=0.8" },
        redirect: "follow",
      })
    } catch {
      return null
    }
    if (!res.ok) return null
    const ct = res.headers.get("content-type") ?? ""
    if (!ct.includes("text/html") && !ct.includes("application/xhtml")) return null

    const html = await res.text()
    const title = decodeEntities(
      (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").trim()
    )
    const lang = html.match(/<html[^>]*\blang=["']?([a-zA-Z-]+)/i)?.[1]
    const text = extractReadable(html).slice(0, this.maxChars)
    if (!text.trim()) return null

    return {
      title: title || url,
      text,
      kind: "article",
      ...(lang ? { language: lang } : {}),
      via: "readability",
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

function extractReadable(html: string): string {
  // Prefer the main content region; fall back to <body>.
  const region =
    html.match(/<article[\s\S]*?<\/article>/i)?.[0] ??
    html.match(/<main[\s\S]*?<\/main>/i)?.[0] ??
    html.match(/<body[\s\S]*?<\/body>/i)?.[0] ??
    html
  return decodeEntities(
    region
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<(nav|header|footer|aside|form)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
  ).trim()
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
}

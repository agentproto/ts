/**
 * ScrapeMcpFetcher — a FetcherPort that delegates article/page fetching to
 * any MCP server exposing a `scrape(url)` tool (e.g. the browser project's
 * tiered router: HTTP → Chromium → Camofox stealth → agent, with cookie
 * injection and auto-escalation on bot-walls). The browser stack is reached
 * over MCP, so this stays vendor-neutral — corpus-cli never imports it.
 *
 *   scrape(url) → { title, markdown } → FetchedSource
 *
 * It does NOT touch video URLs (YtDlpWhisperFetcher owns those) and returns
 * `null` for a blocked / empty page so the importer skips-with-warning
 * rather than aborting the batch.
 *
 * The MCP client is injected as the minimal structural `BrowserMcpLike`
 * (just `callTool`), the same surface `BrowserMcpFetcher` consumes — so this
 * adapter has no MCP-SDK dependency and is unit-testable with a fake client.
 */

import { z } from "zod"
import type { FetcherPort, FetchedSource } from "@agentproto/corpus"
import type { BrowserMcpLike } from "./browser-fetcher.adapter.js"
import { isVideoUrl } from "./video-hosts.js"

/**
 * The fields we read off the `scrape` tool's result. A purifying scrape
 * server returns `title` + `markdown`; we tolerate a raw-`html`-only server
 * by stripping tags as a last resort. Everything else is left opaque.
 */
const SCRAPE_PAYLOAD = z
  .object({
    title: z.string().optional().catch(undefined),
    markdown: z.string().optional().catch(undefined),
    html: z.string().optional().catch(undefined),
    language: z.string().optional().catch(undefined),
    tierUsed: z.union([z.string(), z.number()]).optional().catch(undefined),
  })
  .loose()

const MCP_TEXT_BLOCK = z
  .object({ type: z.literal("text"), text: z.string() })
  .loose()

export interface ScrapeMcpFetcherOptions {
  readonly client: BrowserMcpLike
  /** Tool name on the MCP server — overridable if a host renames it. */
  readonly scrapeToolName?: string
}

export class ScrapeMcpFetcher implements FetcherPort {
  private readonly client: BrowserMcpLike
  private readonly toolName: string

  constructor(opts: ScrapeMcpFetcherOptions) {
    this.client = opts.client
    this.toolName = opts.scrapeToolName ?? "scrape"
  }

  async fetch(url: string): Promise<FetchedSource | null> {
    if (isVideoUrl(url)) return null // let the transcription fetcher handle video

    let res: Awaited<ReturnType<BrowserMcpLike["callTool"]>>
    try {
      res = await this.client.callTool({
        name: this.toolName,
        arguments: { url },
      })
    } catch {
      // Transient MCP/transport failure → skip this URL (resumable re-run
      // retries it), don't abort the whole batch.
      return null
    }
    if (res.isError) return null

    const payload = extractPayload(res)
    if (!payload) return null

    const text = (payload.markdown?.trim() || stripTags(payload.html)).trim()
    if (!text) return null // blocked / empty page → skip

    return {
      title: payload.title?.trim() || url,
      text,
      kind: "article",
      ...(payload.language ? { language: payload.language } : {}),
      via: payload.tierUsed ? `scrape:${payload.tierUsed}` : "scrape",
    }
  }
}

/** Read the scrape result from `structuredContent`, else a JSON text block. */
function extractPayload(res: {
  content?: unknown
  structuredContent?: unknown
}): z.infer<typeof SCRAPE_PAYLOAD> | null {
  if (res.structuredContent && typeof res.structuredContent === "object") {
    const parsed = SCRAPE_PAYLOAD.safeParse(res.structuredContent)
    if (parsed.success) return parsed.data
  }
  if (Array.isArray(res.content)) {
    for (const block of res.content) {
      const text = MCP_TEXT_BLOCK.safeParse(block)
      if (!text.success) continue
      try {
        const parsed = SCRAPE_PAYLOAD.safeParse(JSON.parse(text.data.text))
        if (parsed.success) return parsed.data
      } catch {
        // Non-JSON text block — treat the raw text as the content itself.
        return { markdown: text.data.text }
      }
    }
  }
  return null
}

/** Last-resort tag strip for a server that returns only raw HTML. */
function stripTags(html: string | undefined): string {
  if (!html) return ""
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

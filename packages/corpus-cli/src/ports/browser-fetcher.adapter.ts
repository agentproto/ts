/**
 * BrowserMcpFetcher — a FetcherPort that extracts ARTICLE text through
 * the user's authenticated browser (chrome-devtools-mcp). Use it for
 * pages that a plain HTTP fetch can't read: login-walled, consent-walled,
 * or JS-rendered (SPA) content. For public static articles the cheaper
 * HttpReadabilityFetcher suffices; for video, YtDlpWhisperFetcher handles
 * transcription — this fetcher does NOT touch video.
 *
 *   navigate_page(url) → evaluate_script(readability) → { title, text }
 *
 * (It used to also scrape YouTube captions, but YouTube's caption APIs
 * are pot/SABR-gated and unreliable; transcription via YtDlpWhisperFetcher
 * replaced that path entirely.)
 *
 * The browser is injected as a minimal structural `BrowserMcpLike` (just
 * `callTool`, matching `@agentproto/driver-mcp`'s `McpClient`), so this
 * adapter has no hard MCP-SDK dependency and is unit-testable with a fake
 * client. The CLI wires the real chrome-devtools-mcp client.
 */

import { z } from "zod"
import type { FetcherPort, FetchedSource } from "@agentproto/corpus"
import { isVideoUrl } from "./video-hosts.js"

/** The fetched-source payload the in-browser script returns. */
const FETCHED_PAYLOAD = z
  .object({
    title: z.string(),
    text: z.string(),
    kind: z.enum(["video", "article", "page", "unknown"]).catch("unknown"),
    language: z.string().optional().catch(undefined),
    via: z.string().optional().catch(undefined),
  })
  .loose()

/** An MCP `content` text block. */
const MCP_TEXT_BLOCK = z.object({ type: z.literal("text"), text: z.string() }).loose()

/** Minimal MCP client surface — matches `@agentproto/driver-mcp`'s `McpClient`. */
export interface BrowserMcpLike {
  callTool(args: {
    name: string
    arguments: Record<string, unknown>
  }): Promise<{ content?: unknown; structuredContent?: unknown; isError?: boolean }>
}

export interface BrowserMcpFetcherOptions {
  readonly browser: BrowserMcpLike
  /** chrome-devtools-mcp tool names — overridable if a host renames them. */
  readonly navigateToolName?: string
  readonly evaluateToolName?: string
}

// In-page readability extraction, serialised for evaluate_script. Runs in
// the navigated page's context (cookies/session apply).
const READABILITY_FN = `() => {
  const title = document.title || "";
  const article = document.querySelector("article") || document.querySelector("main");
  const root = article || document.body;
  const text = (root?.innerText || "").replace(/\\n{3,}/g, "\\n\\n").trim().slice(0, 200000);
  const lang = document.documentElement.getAttribute("lang") || undefined;
  return { title, text, kind: "article", language: lang, via: "readability" };
}`

export class BrowserMcpFetcher implements FetcherPort {
  private readonly browser: BrowserMcpLike
  private readonly navigateTool: string
  private readonly evaluateTool: string

  constructor(opts: BrowserMcpFetcherOptions) {
    this.browser = opts.browser
    this.navigateTool = opts.navigateToolName ?? "navigate_page"
    this.evaluateTool = opts.evaluateToolName ?? "evaluate_script"
  }

  async fetch(url: string): Promise<FetchedSource | null> {
    if (isVideoUrl(url)) return null // videos → transcription, not page scrape

    await this.browser.callTool({
      name: this.navigateTool,
      arguments: { url },
    })
    const result = await this.browser.callTool({
      name: this.evaluateTool,
      arguments: { function: READABILITY_FN },
    })
    const extracted = parseEvaluateResult(result)
    if (!extracted || !extracted.text.trim()) return null
    return extracted
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * chrome-devtools-mcp returns the script's return value either as
 * `structuredContent`, or serialised inside a `content` text block.
 * Parse defensively across both shapes.
 */
function parseEvaluateResult(result: {
  content?: unknown
  structuredContent?: unknown
}): FetchedSource | null {
  return (
    coerceFetched(result.structuredContent) ??
    coerceFetched(extractText(result.content))
  )
}

function coerceFetched(value: unknown): FetchedSource | null {
  let obj = value
  if (typeof obj === "string") {
    try {
      obj = JSON.parse(obj)
    } catch {
      return null
    }
  }
  const parsed = FETCHED_PAYLOAD.safeParse(obj)
  if (!parsed.success) return null
  const { title, text, kind, language, via } = parsed.data
  return {
    title,
    text,
    kind,
    ...(language ? { language } : {}),
    ...(via ? { via } : {}),
  }
}

/** Pull a text payload out of an MCP `content` array (or string). */
function extractText(content: unknown): string | null {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    for (const block of content) {
      const parsed = MCP_TEXT_BLOCK.safeParse(block)
      if (parsed.success) return parsed.data.text
    }
  }
  return null
}

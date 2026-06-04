/**
 * connectBrowserMcp — connect to a chrome-devtools-mcp server over MCP
 * streamable-HTTP and return a `BrowserMcpLike` (just `callTool`).
 *
 * ────────────────────────────────────────────────────────────────────
 * TODO(live): this is the ONE environment-coupled seam. It implements a
 * minimal JSON-RPC-over-HTTP client good enough for the common daemon
 * setup, but the exact transport details depend on how YOUR daemon
 * exposes chrome-devtools-mcp. Verify against the running daemon:
 *
 *   1. Response framing — streamable HTTP MAY reply with `text/event-
 *      stream` (SSE) rather than a single JSON body. `parseRpcResponse`
 *      handles both, but confirm the SSE `data:` framing matches.
 *   2. Session header — the spec uses `Mcp-Session-Id`; some servers
 *      omit it (stateless). We echo it back when present.
 *   3. initialize params — protocolVersion / clientInfo may need to
 *      match the server's expected version.
 *
 * If your daemon proxies the browser through a different surface (e.g.
 * the @guilde/tunnel `/mcp` or an agentproto driver), swap this file's
 * impl — the `BrowserMcpLike` contract the fetcher consumes is stable.
 * ────────────────────────────────────────────────────────────────────
 */

import { z } from "zod"
import type { BrowserMcpLike } from "./browser-fetcher.adapter.js"

/** A JSON-RPC response envelope (result/error opaque). */
const RPC_RESPONSE = z
  .object({ result: z.unknown().optional(), error: z.unknown().optional() })
  .loose()

/** An MCP `tools/call` result (content blocks left opaque). */
const CALL_RESULT = z
  .object({
    content: z.unknown().optional(),
    structuredContent: z.unknown().optional(),
    isError: z.boolean().optional(),
  })
  .loose()

export interface ConnectBrowserMcpOptions {
  /** chrome-devtools-mcp streamable-HTTP endpoint, e.g. http://127.0.0.1:9223/mcp */
  readonly endpoint: string
  /** Extra headers (auth tokens, etc.). */
  readonly headers?: Record<string, string>
  readonly protocolVersion?: string
}

const PROTOCOL_VERSION = "2025-06-18"

export async function connectBrowserMcp(
  opts: ConnectBrowserMcpOptions
): Promise<BrowserMcpLike> {
  const client = new StreamableHttpMcpClient(opts)
  await client.initialize()
  return client
}

class StreamableHttpMcpClient implements BrowserMcpLike {
  private id = 0
  private sessionId: string | undefined
  private readonly endpoint: string
  private readonly headers: Record<string, string>
  private readonly protocolVersion: string

  constructor(opts: ConnectBrowserMcpOptions) {
    this.endpoint = opts.endpoint
    this.headers = opts.headers ?? {}
    this.protocolVersion = opts.protocolVersion ?? PROTOCOL_VERSION
  }

  async initialize(): Promise<void> {
    const res = await this.post({
      jsonrpc: "2.0",
      id: ++this.id,
      method: "initialize",
      params: {
        protocolVersion: this.protocolVersion,
        capabilities: {},
        clientInfo: { name: "corpus-cli", version: "0.1.0" },
      },
    })
    // initialized notification (no id, no response expected)
    await this.post(
      { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
      { expectResponse: false }
    )
    if (res?.error) {
      throw new Error(`initialize failed: ${JSON.stringify(res.error)}`)
    }
  }

  async callTool(args: {
    name: string
    arguments: Record<string, unknown>
  }): Promise<{ content?: unknown; structuredContent?: unknown; isError?: boolean }> {
    const res = await this.post({
      jsonrpc: "2.0",
      id: ++this.id,
      method: "tools/call",
      params: { name: args.name, arguments: args.arguments },
    })
    if (res?.error) {
      throw new Error(`tools/call ${args.name} failed: ${JSON.stringify(res.error)}`)
    }
    const parsed = CALL_RESULT.safeParse(res?.result ?? {})
    return parsed.success ? parsed.data : {}
  }

  private async post(
    body: Record<string, unknown>,
    opts: { expectResponse?: boolean } = {}
  ): Promise<{ result?: unknown; error?: unknown } | null> {
    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
        ...this.headers,
      },
      body: JSON.stringify(body),
    })

    const sid = res.headers.get("mcp-session-id")
    if (sid) this.sessionId = sid

    if (opts.expectResponse === false) return null
    if (!res.ok) {
      throw new Error(`MCP HTTP ${res.status} ${res.statusText}`)
    }
    return parseRpcResponse(await res.text(), res.headers.get("content-type"))
  }
}

/** Handle both a single JSON body and SSE (`event:`/`data:`) framing. */
function parseRpcResponse(
  text: string,
  contentType: string | null
): { result?: unknown; error?: unknown } | null {
  if (!text.trim()) return null
  const isSse = (contentType ?? "").includes("text/event-stream")
  if (!isSse) {
    const parsed = RPC_RESPONSE.safeParse(JSON.parse(text))
    return parsed.success ? parsed.data : null
  }
  // SSE: take the last `data:` line that parses to a JSON-RPC response.
  let last: { result?: unknown; error?: unknown } | null = null
  for (const line of text.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed.startsWith("data:")) continue
    const payload = trimmed.slice("data:".length).trim()
    if (!payload || payload === "[DONE]") continue
    try {
      last = JSON.parse(payload)
    } catch {
      // skip non-JSON data frames
    }
  }
  return last
}

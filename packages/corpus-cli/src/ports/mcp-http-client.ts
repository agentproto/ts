/**
 * Minimal streamable-HTTP MCP client (host-agnostic). Used by config-driven
 * sinks/sources to call ANY MCP server's tools — the corpus never names a
 * specific host; the endpoint + tool come from a manifest.
 *
 * Handles both JSON and SSE (`text/event-stream`) responses, optional
 * `Mcp-Session-Id`, and the initialize handshake.
 */

import { z } from "zod"

/** JSON-RPC envelope (result/error opaque). */
const RPC_RESPONSE = z
  .object({ result: z.unknown().optional(), error: z.unknown().optional() })
  .loose()

/** A JSON-RPC message with an id (SSE-delivered responses). */
const RPC_MESSAGE = z
  .object({
    id: z.number().optional(),
    result: z.unknown().optional(),
    error: z.unknown().optional(),
  })
  .loose()

/** An MCP `tools/call` result (content blocks left opaque). */
const CALL_RESULT = z
  .object({
    content: z.unknown().optional(),
    structuredContent: z.unknown().optional(),
    isError: z.boolean().optional(),
  })
  .loose()

export interface McpClientLike {
  callTool(name: string, args: Record<string, unknown>): Promise<{
    content?: unknown
    structuredContent?: unknown
    isError?: boolean
  }>
}

export interface ConnectMcpHttpOptions {
  readonly endpoint: string
  readonly headers?: Record<string, string>
  readonly protocolVersion?: string
  /** "streamable-http" (POST, default) or "sse" (legacy GET stream + POST messages). */
  readonly transport?: "streamable-http" | "sse"
}

export async function connectMcpHttp(
  opts: ConnectMcpHttpOptions
): Promise<McpClientLike> {
  if (opts.transport === "sse") {
    const sse = new SseMcpClient(opts)
    await sse.connect()
    return sse
  }
  const client = new StreamableHttpMcpClient(opts)
  await client.initialize()
  return client
}

class StreamableHttpMcpClient implements McpClientLike {
  private id = 0
  private sessionId: string | undefined
  private readonly endpoint: string
  private readonly headers: Record<string, string>
  private readonly protocolVersion: string

  constructor(opts: ConnectMcpHttpOptions) {
    this.endpoint = opts.endpoint
    this.headers = opts.headers ?? {}
    this.protocolVersion = opts.protocolVersion ?? "2025-06-18"
  }

  async initialize(): Promise<void> {
    const res = await this.rpc({
      jsonrpc: "2.0",
      id: ++this.id,
      method: "initialize",
      params: {
        protocolVersion: this.protocolVersion,
        capabilities: {},
        clientInfo: { name: "corpus-cli", version: "0.1.0" },
      },
    })
    await this.rpc({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }, false)
    if (res?.error) throw new Error(`initialize failed: ${JSON.stringify(res.error)}`)
  }

  async callTool(name: string, args: Record<string, unknown>) {
    const res = await this.rpc({
      jsonrpc: "2.0",
      id: ++this.id,
      method: "tools/call",
      params: { name, arguments: args },
    })
    if (res?.error) throw new Error(`tools/call ${name}: ${JSON.stringify(res.error)}`)
    const parsed = CALL_RESULT.safeParse(res?.result ?? {})
    return parsed.success ? parsed.data : {}
  }

  private async rpc(
    body: Record<string, unknown>,
    expectResponse = true
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
    if (!expectResponse) return null
    if (!res.ok) throw new Error(`MCP HTTP ${res.status} ${res.statusText}`)
    return parseRpc(await res.text(), res.headers.get("content-type"))
  }
}

/**
 * Legacy HTTP+SSE MCP transport: GET the stream → first `endpoint` event gives
 * the POST URL → POST JSON-RPC requests there; responses arrive back on the
 * stream (correlated by id). Used for servers like Guilde's `/guilde/mcp/sse`.
 */
class SseMcpClient implements McpClientLike {
  private id = 0
  private messagesUrl: string | undefined
  private readonly pending = new Map<number, (msg: { result?: unknown; error?: unknown }) => void>()
  private readyResolve!: () => void
  private readonly ready = new Promise<void>(r => (this.readyResolve = r))
  private readonly base: URL

  constructor(private readonly opts: ConnectMcpHttpOptions) {
    this.base = new URL(opts.endpoint)
  }

  async connect(): Promise<void> {
    const res = await fetch(this.opts.endpoint, {
      headers: { accept: "text/event-stream", ...(this.opts.headers ?? {}) },
    })
    if (!res.ok || !res.body) throw new Error(`SSE connect ${res.status} ${res.statusText}`)
    void this.readLoop(res.body.getReader())
    // Wait for the endpoint event (POST url), then initialize.
    await withTimeout(this.ready, 10_000, "SSE endpoint event")
    const init = await this.send("initialize", {
      protocolVersion: this.opts.protocolVersion ?? "2025-06-18",
      capabilities: {},
      clientInfo: { name: "corpus-cli", version: "0.1.0" },
    })
    if (init?.error) throw new Error(`initialize failed: ${JSON.stringify(init.error)}`)
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })
  }

  async callTool(name: string, args: Record<string, unknown>) {
    const res = await this.send("tools/call", { name, arguments: args })
    if (res?.error) throw new Error(`tools/call ${name}: ${JSON.stringify(res.error)}`)
    const parsed = CALL_RESULT.safeParse(res?.result ?? {})
    return parsed.success ? parsed.data : {}
  }

  private async send(method: string, params: unknown) {
    const id = ++this.id
    const wait = new Promise<{ result?: unknown; error?: unknown }>(resolve => this.pending.set(id, resolve))
    await this.post({ jsonrpc: "2.0", id, method, params })
    return withTimeout(wait, 60_000, `${method} response`)
  }

  private async post(body: Record<string, unknown>): Promise<void> {
    if (!this.messagesUrl) throw new Error("SSE messages endpoint not ready")
    const res = await fetch(this.messagesUrl, {
      method: "POST",
      headers: { "content-type": "application/json", ...(this.opts.headers ?? {}) },
      body: JSON.stringify(body),
    })
    if (!res.ok && res.status !== 202) throw new Error(`SSE POST ${res.status}`)
  }

  private async readLoop(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
    const dec = new TextDecoder()
    let buf = ""
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let nl: number
      while ((nl = buf.indexOf("\n\n")) >= 0) {
        const raw = buf.slice(0, nl)
        buf = buf.slice(nl + 2)
        this.handleEvent(raw)
      }
    }
  }

  private handleEvent(raw: string): void {
    let event = "message"
    const data: string[] = []
    for (const line of raw.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim()
      else if (line.startsWith("data:")) data.push(line.slice(5).trim())
    }
    const payload = data.join("\n")
    if (event === "endpoint") {
      this.messagesUrl = new URL(payload, this.base).toString()
      this.readyResolve()
      return
    }
    if (!payload) return
    try {
      const parsed = RPC_MESSAGE.safeParse(JSON.parse(payload))
      if (!parsed.success) return
      const msg = parsed.data
      if (typeof msg.id === "number" && this.pending.has(msg.id)) {
        this.pending.get(msg.id)!(msg)
        this.pending.delete(msg.id)
      }
    } catch {
      /* skip non-JSON */
    }
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timeout waiting for ${what}`)), ms)),
  ])
}

function parseRpc(
  text: string,
  contentType: string | null
): { result?: unknown; error?: unknown } | null {
  if (!text.trim()) return null
  if (!(contentType ?? "").includes("text/event-stream")) {
    const parsed = RPC_RESPONSE.safeParse(JSON.parse(text))
    return parsed.success ? parsed.data : null
  }
  let last: { result?: unknown; error?: unknown } | null = null
  for (const line of text.split("\n")) {
    const t = line.trim()
    if (!t.startsWith("data:")) continue
    const p = t.slice(5).trim()
    if (!p || p === "[DONE]") continue
    try {
      last = JSON.parse(p)
    } catch {
      /* skip non-JSON frames */
    }
  }
  return last
}

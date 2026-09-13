/**
 * Narrow public ingress proxy for Telegram (and other) bot webhooks.
 *
 * SECURITY: the daemon's port (default 18790) exposes the entire control
 * plane — `session_list`, `agent_start`, `agent_kill`, etc. A bare public
 * tunnel to that port would expose full daemon control to anyone who finds
 * the URL. This proxy listens on its own port and forwards ONLY
 * `POST /inbound/*` to the daemon. Every other path or method is rejected
 * with 404/405.
 */

import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from "node:http"

export interface TelegramProxyOptions {
  targetBaseUrl: string
  listenPort: number
  log?: (msg: string) => void
}

export interface TelegramProxy {
  start(): Promise<{ url: string; port: number }>
  stop(): Promise<void>
}

/**
 * Create a narrow reverse-proxy that forwards ONLY `POST /inbound/*`
 * to a target base URL. Every other path or method is rejected.
 *
 * SECURITY: the URL path is decoded, normalized (resolving `.` and `..`),
 * and then checked. Only paths whose normalized form literally begins with
 * `/inbound/` are forwarded. Path-traversal attempts such as
 * `/inbound/../sessions/foo` decode and normalize to `/sessions/foo`, which
 * does not start with `/inbound/` and is rejected with 404.
 */
export function createTelegramProxy(opts: TelegramProxyOptions): TelegramProxy {
  const log = opts.log ?? (() => {})
  let server: Server | null = null

  return {
    async start() {
      server = createServer((req, res) => {
        handleProxyRequest(req, res, opts, log)
      })

      return new Promise<{ url: string; port: number }>((resolve, reject) => {
        server!.once("error", reject)
        server!.listen(opts.listenPort, "127.0.0.1", () => {
          const addr = server!.address()
          const port = typeof addr === "object" && addr !== null ? addr.port : opts.listenPort
          const url = `http://127.0.0.1:${port}`
          log(`[telegram-proxy] listening on ${url}`)
          resolve({ url, port })
        })
      })
    },

    async stop() {
      if (!server) return
      await new Promise<void>((resolve, reject) => {
        server!.close(err => {
          if (err) reject(err)
          else resolve()
        })
      })
      server = null
    },
  }
}

function handleProxyRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: TelegramProxyOptions,
  log: (msg: string) => void,
): void {
  // Only POST is allowed.
  if (req.method !== "POST") {
    res.writeHead(405, { "content-type": "application/json" })
    res.end(JSON.stringify({ error: "method_not_allowed" }))
    return
  }

  const rawUrl = req.url ?? "/"
  const normalized = normalizePath(rawUrl)

  // SECURITY: only forward paths whose normalized form literally begins with /inbound/
  if (!normalized.startsWith("/inbound/")) {
    res.writeHead(404, { "content-type": "application/json" })
    res.end(JSON.stringify({ error: "not_found" }))
    return
  }

  const targetUrl = new URL(normalized, opts.targetBaseUrl)
  // Preserve query string.
  const queryIdx = rawUrl.indexOf("?")
  if (queryIdx >= 0) {
    targetUrl.search = rawUrl.slice(queryIdx)
  }

  log(`[telegram-proxy] ${req.method} ${rawUrl} -> ${targetUrl.toString()}`)

  // Build headers: forward everything except Host, which we rewrite.
  const headers: Record<string, string | string[]> = {}
  for (const [key, value] of Object.entries(req.headers)) {
    if (value !== undefined) {
      headers[key] = value
    }
  }
  headers.host = targetUrl.host

  const proxyReq = request(
    {
      hostname: targetUrl.hostname,
      port: targetUrl.port || (targetUrl.protocol === "https:" ? 443 : 80),
      path: targetUrl.pathname + targetUrl.search,
      method: req.method,
      headers,
    },
    proxyRes => {
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers)
      proxyRes.pipe(res)
    },
  )

  proxyReq.on("error", err => {
    log(`[telegram-proxy] upstream error: ${err.message}`)
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: "bad_gateway" }))
    }
  })

  // The proxy does not follow redirects; it passes the upstream response
  // (including 301/302) straight through to the caller. This is the default
  // behaviour of node:http.request.

  req.pipe(proxyReq)
}

/**
 * Decode percent-encoding and collapse `.` / `..` segments.
 * Returns the raw path part on malformed percent-encoding so it fails the
 * `/inbound/` prefix check downstream.
 */
function normalizePath(urlPath: string): string {
  const pathPart = urlPath.split("?")[0] ?? urlPath

  let decoded: string
  try {
    decoded = decodeURIComponent(pathPart)
  } catch {
    // Malformed percent-encoding — return raw so it fails the allowlist.
    return pathPart
  }

  const hasTrailingSlash = decoded.endsWith("/") && decoded !== "/"

  const segments = decoded.split("/").filter(s => s !== "" && s !== ".")
  const normalized: string[] = []
  for (const seg of segments) {
    if (seg === "..") {
      normalized.pop()
    } else {
      normalized.push(seg)
    }
  }

  let result = "/" + normalized.join("/")
  if (hasTrailingSlash && !result.endsWith("/")) {
    result += "/"
  }
  return result
}

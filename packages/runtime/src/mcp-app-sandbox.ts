/**
 * Dedicated sandbox origin for MCP App views (MCP Apps spec, "Rendering the
 * MCP App": the host and the view iframe MUST have different origins, the view
 * MUST run with `allow-same-origin`, and its document MUST be served by a
 * server the host controls with the CSP as an HTTP header).
 *
 * The daemon is that server. A host page registers a view
 * (`POST /mcp-app-sandbox/views`, same auth as the other mutating routes) and
 * gets back a URL on an origin that is NOT the daemon's:
 *
 * - `subdomain` (default): `http://<token>.sandbox.localhost:<daemon-port>/v/<token>`.
 *   Chrome/Firefox resolve `*.localhost` to loopback; every view gets its own
 *   origin (no storage shared between views). Served by the daemon's own
 *   listener, routed by `Host` BEFORE any daemon route.
 * - `port`: `http://127.0.0.1:<sandbox-port>/v/<token>` on a second listener
 *   (fallback where `*.localhost` does not resolve). One origin for all views.
 * - `publicOrigin`: one fixed hostname (a tunnel hostname) that routes to this
 *   daemon; one origin for all views. It MUST be a hostname DEDICATED to
 *   sandbox views: every request arriving on it is served by the sandbox
 *   handler (documents only), so the daemon's own API is unreachable there.
 * - `off`: no sandbox origin; hosts fall back to the opaque-origin srcdoc.
 *
 * Security invariants (each has a test in `__tests__/mcp-app-sandbox*.test.ts`):
 * - R1: a sandbox origin is never trusted by the daemon. Any request to the
 *   daemon's routes whose `Origin` (or `Referer`) is a sandbox origin is
 *   refused with 403, whatever the allowlist says (`isSandboxRequest`). This
 *   is NECESSARY, NOT SUFFICIENT: the view's documents are served with
 *   `Referrer-Policy: no-referrer`, so a `no-cors` subresource request carries
 *   neither header. The network boundary for those is the CSP (R3: `connect-src`
 *   etc. never name the daemon) plus the fact that the daemon's state-changing
 *   routes require a bearer or an allowlisted Origin, and a `no-cors` response
 *   is opaque to the view.
 * - R2: a sandbox host serves ONLY `GET|HEAD /v/<token>`; every other path or
 *   method is 404/405 and never reaches a daemon route. No CORS headers.
 * - R3: the CSP is an HTTP header built server-side from the registered
 *   metadata; sources that target the daemon itself are dropped.
 * - R4: tokens are 128-bit random, expire, and the store is bounded.
 * - R6: `frame-ancestors` is pinned to the origin that registered the view.
 * - R7: in `subdomain` mode the token is also the host label, so a document
 *   is only served on its own origin.
 */

import { randomBytes } from "node:crypto"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { McpAppUiCsp } from "@agentproto/mcp-app-host/csp"
import { buildSandboxCspHeader, toOrigin } from "@agentproto/mcp-app-host/csp"

export type McpAppSandboxMode = "subdomain" | "port" | "off"

export interface McpAppSandboxOptions {
  /** Default `subdomain`. */
  mode?: McpAppSandboxMode
  /** `port` mode: the dedicated listener's port (required for that mode). */
  port?: number
  /** A fixed public origin (e.g. a tunnel hostname) that also serves views.
   *  `https://host[:port]`, no path. */
  publicOrigin?: string
  /** View lifetime. Default 15 minutes (a view's URL is loaded once, at mount). */
  ttlMs?: number
  /** Max live views; the oldest is evicted. Default 256. */
  maxViews?: number
  /** Max registered HTML size in bytes. Default 5 MiB. */
  maxHtmlBytes?: number
  /** Total bytes of live HTML across views; the oldest are evicted past it.
   *  Default 64 MiB. */
  maxTotalBytes?: number
}

export interface RegisteredView {
  token: string
  url: string
  origin: string
  mode: Exclude<McpAppSandboxMode, "off"> | "public"
}

interface StoredView {
  html: string
  bytes: number
  csp: McpAppUiCsp | undefined
  ancestor: string | undefined
  /** Hostname the registering page was reached on (may differ from the Origin's). */
  pageHost: string | undefined
  expiresAt: number
}

/** Where a request to the sandbox side came in. */
export type SandboxHostKind =
  | { kind: "subdomain"; label: string }
  | { kind: "public" }
  | { kind: "port" }

const TOKEN = /^[0-9a-f]{32}$/
const SANDBOX_SUFFIX = ".sandbox.localhost"
/** Local-network name suffixes (matched against `.host`). */
const LOCAL_SUFFIX = /\.(localhost|local|internal|localdomain|lan|home|corp|home\.arpa|intranet|private)$/
const LOOPBACK_NAMES = new Set(["127.0.0.1", "localhost", "[::1]"])
const DEFAULT_TTL_MS = 15 * 60 * 1000
const DEFAULT_MAX_VIEWS = 256
const DEFAULT_MAX_HTML = 5 * 1024 * 1024
const DEFAULT_MAX_TOTAL = 64 * 1024 * 1024

function splitHost(hostHeader: string | undefined): { name: string; port: string } | null {
  if (!hostHeader) return null
  const host = hostHeader.toLowerCase()
  const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+|\*))?$/.exec(host)
  if (!m) return null
  return { name: m[1] ?? "", port: m[2] ?? "" }
}

/** Lowercase, no trailing dot (`a.example.com.` and `a.example.com` are the same host). */
function canonName(name: string): string {
  return name.toLowerCase().replace(/\.+$/, "")
}

function defaultPort(protocol: string): string {
  return protocol === "https:" ? "443" : "80"
}

function originOf(value: string | undefined): URL | null {
  if (!value || value === "null") return null
  try {
    return new URL(value)
  } catch {
    return null
  }
}

/** Loopback, unspecified, private, link-local, CGNAT and ULA addresses (host
 *  already canonicalised by the URL parser, IPv6 still bracketed). */
function isLocalAddress(host: string): boolean {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const [a, b] = host.split(".").map(Number) as [number, number]
    return (
      a === 127 || a === 0 || a === 10 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19))
    )
  }
  // Every IPv6 literal (loopback, mapped, compatible, NAT64, 6to4, ULA,
  // link-local, …) is dropped: there is no legitimate reason for a view to
  // name one, and enumerating the local ranges is how holes appear.
  if (host.startsWith("[")) return true
  return false
}

export interface McpAppSandbox {
  readonly mode: McpAppSandboxMode
  readonly enabled: boolean
  /** `Host` header → sandbox kind, or null when it is a daemon (host) request. */
  classifyHost(hostHeader: string | undefined): SandboxHostKind | null
  /** True when `origin` is one of the sandbox origins (any view). */
  isSandboxOrigin(origin: string | undefined): boolean
  /** R1: the request's `Origin` or `Referer` is a sandbox origin. */
  isSandboxRequest(req: IncomingMessage): boolean
  /** Register a view; `requestHost` is the `Host` the registering call used.
   *  Returns `null` when the registering page was reached through a
   *  non-loopback host and no `publicOrigin` is configured: a `*.localhost`
   *  URL would resolve to the VIEWER's own machine, not this daemon. */
  register(input: {
    html: string
    csp?: McpAppUiCsp
    ancestor?: string
    requestHost?: string
  }): RegisteredView | null
  /** Serve a sandbox-side request (GET|HEAD /v/<token> only). */
  handle(req: IncomingMessage, res: ServerResponse, kind: SandboxHostKind): void
  /** `port` mode: start the dedicated listener. No-op for other modes. */
  listen(bind: string): Promise<void>
  close(): Promise<void>
  readonly maxHtmlBytes: number
  /** Live view count (tests). */
  size(): number
}

export function createMcpAppSandbox(
  opts: McpAppSandboxOptions | undefined,
  daemon: { port: number; bind?: string; now?: () => number },
): McpAppSandbox {
  const mode: McpAppSandboxMode = opts?.mode ?? "subdomain"
  const now = daemon.now ?? Date.now
  const ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS
  const maxViews = opts?.maxViews ?? DEFAULT_MAX_VIEWS
  const maxHtmlBytes = opts?.maxHtmlBytes ?? DEFAULT_MAX_HTML
  const maxTotalBytes = opts?.maxTotalBytes ?? DEFAULT_MAX_TOTAL
  const sandboxPort = mode === "port" ? opts?.port : undefined
  const publicOrigin = (() => {
    const o = originOf(opts?.publicOrigin)
    return o && (o.protocol === "https:" || o.protocol === "http:") ? o.origin : undefined
  })()
  const publicUrl = publicOrigin ? new URL(publicOrigin) : undefined
  const publicName = publicUrl ? canonName(publicUrl.hostname) : undefined
  const publicPort = publicUrl ? publicUrl.port || defaultPort(publicUrl.protocol) : undefined
  /** `Host` header → is it the public sandbox hostname (case, trailing dot, default port). */
  const isPublicHost = (hostHeader: string | undefined): boolean => {
    const h = splitHost(hostHeader)
    if (!h || !publicName || !publicPort) return false
    // Name only: any port on the public sandbox hostname is sandbox-side (fail closed).
    return canonName(h.name) === publicName
  }
  const views = new Map<string, StoredView>()
  let listener: Server | undefined

  if (mode === "port" && (!sandboxPort || sandboxPort === daemon.port)) {
    throw new Error("mcpAppSandbox.mode \"port\" needs a `port` different from the daemon's own")
  }

  function totalBytes(): number {
    let n = 0
    for (const v of views.values()) n += v.bytes
    return n
  }

  function sweep(): void {
    const t = now()
    for (const [token, v] of views) if (v.expiresAt <= t) views.delete(token)
    while (views.size > maxViews || (views.size > 0 && totalBytes() > maxTotalBytes)) {
      const oldest = views.keys().next().value
      if (oldest === undefined) break
      views.delete(oldest)
    }
  }

  function isSandboxOrigin(origin: string | undefined): boolean {
    const u = originOf(origin)
    if (!u) return false
    const host = canonName(u.hostname)
    if (host === "sandbox.localhost" || host.endsWith(SANDBOX_SUFFIX)) return true
    if (publicName && publicPort && host === publicName && (u.port || defaultPort(u.protocol)) === publicPort) {
      return true
    }
    if (sandboxPort !== undefined && Number(u.port || defaultPort(u.protocol)) === sandboxPort) {
      // Any name pointing at the sandbox port is the sandbox origin.
      return true
    }
    return false
  }

  /**
   * CSP sources a sandbox view must not be granted (R1/R3). Dropped, not
   * rewritten: every loopback or local-network host in ANY spelling (the URL
   * parser canonicalises `127.1`, `2130706433`, `0x7f.1`, `[::ffff:7f00:1]`,
   * trailing dots, …) on any port: loopback, `localhost` / `*.localhost`,
   * `0.0.0.0`, RFC 1918 / link-local / CGNAT / ULA / `.local` / `.internal`
   * (the daemon may be bound to a LAN address); the registering page's own
   * hostname on any port; the broad forms that would cover a plain-http
   * local server (`*`, bare `http:` / `ws:`); and `data:` / `about:` /
   * `javascript:` (opaque-origin frames would send `Origin: null`, which no
   * origin guard can attribute to a sandbox).
   */
  function targetsDaemon(source: string, ancestor: string | undefined, pageHost: string | undefined): boolean {
    const raw = source.toLowerCase()
    if (raw === "*" || raw === "http:" || raw === "ws:" || raw === "data:" || raw === "about:" || raw === "javascript:") {
      return true
    }
    // A bare scheme (`https:`, `wss:`, `blob:`, …) names no host; the dangerous
    // ones (`http:`, `ws:`, `data:`, …) were handled above.
    if (/^[a-z][a-z0-9+.-]*:$/.test(raw)) return false
    const scheme = /^([a-z][a-z0-9+.-]*):\/\//.exec(raw)?.[1]
    const hostPart = raw
      .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
      .replace(/[/?#].*$/, "")
      .replace(/^[^@]*@/, "")
    const bare = hostPart.replace(/:(\d+|\*)$/, "")
    // A host of `*` (`http://*`, `*:*`, `*:7777`) covers loopback on plain http/ws.
    if (bare === "*") return scheme !== "https" && scheme !== "wss"
    const pageHosts = [ancestor ? originOf(ancestor)?.hostname : undefined, pageHost]
      .filter((h): h is string => !!h)
      .map(canonName)
    const wildcard = bare.startsWith("*.")
    const base = canonName(wildcard ? bare.slice(2) : bare)
    // Wildcard hosts: anything wildcarding a local suffix, or covering the page's own host.
    if (wildcard) {
      if (LOCAL_SUFFIX.test(`.${base}`)) return true
      return pageHosts.some((h) => h === base || h.endsWith(`.${base}`))
    }
    let host = ""
    try {
      // A scheme-qualified URL so the WHATWG parser canonicalises the host.
      host = canonName(new URL(`http://${bare}`).hostname)
    } catch {
      return true // fail closed: drop what the URL parser refuses
    }
    if (host === "localhost" || LOCAL_SUFFIX.test(`.${host}`)) return true
    if (!host.includes(".") && !host.startsWith("[")) return true // single-label LAN names (`mac-studio`)
    if (isLocalAddress(host)) return true
    return pageHosts.includes(host)
  }

  function viewUrl(token: string, requestHost: string | undefined): RegisteredView | null {
    // The public (tunnel) sandbox hostname is used when the registering page
    // was reached through a non-loopback host (it is a different hostname from
    // the sandbox one: the sandbox hostname never serves the daemon API); a
    // page on a loopback host keeps a local sandbox origin.
    const hostName = splitHost(requestHost)?.name
    const remote = hostName !== undefined && !LOOPBACK_NAMES.has(canonName(hostName))
    if (publicOrigin && remote) {
      return { token, url: `${publicOrigin}/v/${token}`, origin: publicOrigin, mode: "public" }
    }
    if (remote) return null
    if (mode === "port" && sandboxPort !== undefined) {
      // A hostname different from the page's: cookies ignore ports, so the same
      // name would put the view in the daemon page's cookie jar.
      const name = hostName === "127.0.0.1" ? "localhost" : "127.0.0.1"
      const origin = `http://${name}:${sandboxPort}`
      return { token, url: `${origin}/v/${token}`, origin, mode: "port" }
    }
    const origin = `http://${token}${SANDBOX_SUFFIX}:${daemon.port}`
    return { token, url: `${origin}/v/${token}`, origin, mode: "subdomain" }
  }

  function notFound(res: ServerResponse): void {
    res.writeHead(404, {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    })
    res.end("not found")
  }

  const handle: McpAppSandbox["handle"] = (req, res, kind) => {
    const method = req.method ?? "GET"
    if (method !== "GET" && method !== "HEAD") {
      res.writeHead(405, { allow: "GET, HEAD", "cache-control": "no-store" })
      res.end()
      return
    }
    const path = (req.url ?? "/").split("?")[0] ?? "/"
    const m = /^\/v\/([0-9a-f]{32})$/.exec(path)
    const token = m?.[1]
    if (!token || !TOKEN.test(token)) {
      notFound(res)
      return
    }
    // R7: in subdomain mode a document is served only on its own origin.
    if (kind.kind === "subdomain" && kind.label !== token) {
      notFound(res)
      return
    }
    sweep()
    const view = views.get(token)
    if (!view) {
      notFound(res)
      return
    }
    const csp = buildSandboxCspHeader(view.csp, view.ancestor, {
      dropSource: (s) => targetsDaemon(s, view.ancestor, view.pageHost),
    })
    // `port` / `public` give every view the SAME origin, so storage would be
    // shared between views. Wiping the origin's storage on each document load
    // stops one view reading what an earlier one left behind (concurrently
    // open views still share it: only `subdomain` mode isolates those).
    const sharedOrigin = kind.kind !== "subdomain"
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": csp,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      ...(sharedOrigin
        ? { "clear-site-data": kind.kind === "public" ? '"cache", "cookies", "storage"' : '"cache", "storage"' }
        : {}),
    })
    res.end(method === "HEAD" ? undefined : view.html)
  }

  return {
    mode,
    enabled: mode !== "off",
    maxHtmlBytes,
    size: () => views.size,

    classifyHost(hostHeader) {
      if (mode === "off") return null
      const h = splitHost(hostHeader)
      if (!h) return null
      const name = canonName(h.name)
      if (name === "sandbox.localhost" || name.endsWith(SANDBOX_SUFFIX)) {
        const label = name === "sandbox.localhost" ? "" : name.slice(0, -SANDBOX_SUFFIX.length)
        return { kind: "subdomain", label }
      }
      if (isPublicHost(hostHeader)) return { kind: "public" }
      return null
    },

    isSandboxOrigin,

    isSandboxRequest(req) {
      const origin = req.headers.origin
      if (typeof origin === "string" && isSandboxOrigin(origin)) return true
      const referer = req.headers.referer
      if (typeof referer === "string") {
        const r = originOf(referer)
        if (r && isSandboxOrigin(r.origin)) return true
      }
      return false
    },

    register({ html, csp, ancestor, requestHost }) {
      sweep()
      const token = randomBytes(16).toString("hex")
      const url = viewUrl(token, requestHost)
      if (!url) return null
      const cleanAncestor = toOrigin(ancestor)
      // A sandbox origin can never be the embedder (it would be R1 in reverse).
      views.set(token, {
        html,
        bytes: Buffer.byteLength(html, "utf8"),
        csp,
        ancestor: cleanAncestor && !isSandboxOrigin(cleanAncestor) ? cleanAncestor : undefined,
        pageHost: (() => {
          const n = splitHost(requestHost)?.name
          return n ? canonName(n) : undefined
        })(),
        expiresAt: now() + ttlMs,
      })
      sweep()
      return url
    },

    handle,

    async listen(bind) {
      if (mode !== "port" || sandboxPort === undefined || listener) return
      const srv = createServer((req, res) => {
        const h = splitHost(req.headers.host)
        if (!h || !LOOPBACK_NAMES.has(canonName(h.name)) || h.port !== String(sandboxPort)) {
          res.writeHead(403, { "content-type": "text/plain", "cache-control": "no-store" })
          res.end("forbidden host")
          return
        }
        handle(req, res, { kind: "port" })
      })
      await new Promise<void>((resolve, reject) => {
        srv.once("error", reject)
        srv.listen(sandboxPort, bind, () => resolve())
      })
      listener = srv
    },

    async close() {
      const srv = listener
      listener = undefined
      if (srv) await new Promise<void>((resolve) => srv.close(() => resolve()))
      views.clear()
    },
  }
}

/** Parse + validate the registration body. Never throws; returns an error code. */
export function parseRegistration(
  body: unknown,
  maxHtmlBytes: number,
): { ok: true; html: string; csp: McpAppUiCsp | undefined } | { ok: false; error: string } {
  if (typeof body !== "object" || body === null) return { ok: false, error: "invalid_body" }
  const { html, csp } = body as { html?: unknown; csp?: unknown }
  if (typeof html !== "string" || html.length === 0) return { ok: false, error: "invalid_html" }
  if (Buffer.byteLength(html, "utf8") > maxHtmlBytes) return { ok: false, error: "html_too_large" }
  let cleanCsp: McpAppUiCsp | undefined
  if (csp !== undefined && csp !== null) {
    if (typeof csp !== "object") return { ok: false, error: "invalid_csp" }
    cleanCsp = {}
    for (const key of ["connectDomains", "resourceDomains", "frameDomains", "baseUriDomains"] as const) {
      const v = (csp as Record<string, unknown>)[key]
      if (v === undefined) continue
      if (!Array.isArray(v) || v.length > 100 || v.some((d) => typeof d !== "string" || d.length > 512)) {
        return { ok: false, error: "invalid_csp" }
      }
      cleanCsp[key] = v as string[]
    }
  }
  return { ok: true, html, csp: cleanCsp }
}

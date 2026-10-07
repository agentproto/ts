/**
 * Link guard — the access gate `TunnelRegistry` installs in front of a
 * target port BEFORE handing it to a tunnel provider (quick/named/ngrok/…).
 *
 * Context: `tunnel_create`'s own doc used to say "this does NOT gate auth —
 * pure passthrough". That was fine when the provider was always
 * `cloudflare-quick` and the URL was a throwaway *.trycloudflare.com link
 * nobody could guess — but it means literally anyone who finds the link (a
 * forwarded message, a leaked screenshot, a crawler that stumbled onto
 * *.trycloudflare.com) gets full access, forever, with no way to revoke it.
 *
 * This module is that gate. It is a tiny reverse proxy that:
 *   - listens on 127.0.0.1 on an ephemeral port and forwards to the real
 *     target ({@link ProviderStartOptions.target} equivalent);
 *   - requires a signed token, either `?t=<token>` on the URL or a cookie
 *     set on the first authenticated hit (so the token never lingers in
 *     browser history / the Referer header after that);
 *   - enforces a TTL — a request after `expiresAt` is rejected even with a
 *     once-valid token;
 *   - can be revoked instantly ({@link LinkGuard.revoke}) — it rotates the
 *     signing secret, so every token and cookie issued so far stops
 *     verifying immediately, independent of the TTL;
 *   - stamps every response (including its own 403s) with
 *     `X-Robots-Tag: noindex`, and blocks a dev server's own dangerous
 *     surface (`/@fs/…`, any `*.map` source map) even for an authenticated
 *     viewer — those exist to let compilers log, no tunnel was ever meant to
 *     carry them to a stranger.
 *
 * `TunnelRegistry.create` wires this in front of EVERY provider by default
 * (`access: "public"` is the explicit, logged opt-out — see
 * `tunnel-tools.ts`). The tunnel provider itself (cloudflared, ngrok, …)
 * just forwards to `127.0.0.1:<guard port>` instead of the real target; it
 * never sees the difference.
 *
 * Not covered (documented limitation, not a bug): WebSocket upgrades are not
 * proxied, so a dev server's HMR socket will not work through the guard.
 * Serve a built `dist/` (or `vite preview`) rather than a live dev server —
 * `quick.ts`'s own doc recommends the same thing for an unrelated reason
 * (ingress shadowing).
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import {
  createServer,
  request,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http"

export interface LinkGuardOptions {
  /** The real target this guard forwards authenticated requests to. */
  target: { host: string; port: number }
  /** How long an issued token/cookie stays valid. Default 24h. */
  ttlMs?: number
  onLog?: (line: string) => void
}

export interface LinkGuardHandle {
  /** The guard's own listen port (127.0.0.1). */
  port: number
  /** The current bearer token — append as `?t=<token>` to the public URL. */
  token: string
  /** ISO timestamp the current token stops verifying at. */
  expiresAt: string
}

export interface LinkGuard {
  start(): Promise<LinkGuardHandle>
  stop(): Promise<void>
  /**
   * Rotate the signing secret and mint a fresh token on a fresh TTL window.
   * Every previously issued link or cookie — however many copies are
   * floating around — stops verifying on the very next request. Call this
   * from `tunnel_revoke`, or on `tunnel_stop` before tearing the guard down.
   */
  revoke(): LinkGuardHandle
}

export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000
const MIN_TTL_MS = 60_000
const MAX_TTL_MS = 30 * 24 * 60 * 60 * 1000

const TTL_UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
}
const TTL_PATTERN = /^(\d+)(ms|s|m|h|d)?$/

/** Parse a `ttl` flag ("24h", "7d", "90m", bare = ms) into milliseconds,
 *  clamped to [1min, 30d]. An absent or unparsable value falls back to the
 *  24h default rather than throwing — a malformed ttl is far more likely a
 *  caller typo than intent, and refusing to create the tunnel over it would
 *  be a worse failure mode than a sane default. */
export function parseTtlMs(input?: string): number {
  if (!input) return DEFAULT_TTL_MS
  const match = TTL_PATTERN.exec(input.trim())
  if (!match) return DEFAULT_TTL_MS
  const n = Number(match[1])
  const unit = match[2] ?? "ms"
  const ms = n * (TTL_UNIT_MS[unit] ?? 1)
  if (!Number.isFinite(ms) || ms <= 0) return DEFAULT_TTL_MS
  return Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, ms))
}

/** `__Host-` prefix: the browser itself refuses this cookie unless it is
 *  `Secure`, has `Path=/`, and carries no `Domain` attribute — exactly the
 *  three properties below, so a misconfiguration can never silently leak
 *  the cookie to a parent/sibling domain. */
export const COOKIE_NAME = "__Host-ap_tunnel"
const TOKEN_QUERY_PARAM = "t"
const TOKEN_MESSAGE = "agentproto-tunnel-link-v1"

/** Dev-server paths that leak the filesystem or source, blocked even for an
 *  authenticated viewer: Vite's raw-filesystem passthrough, and any source
 *  map (`.js.map`, `.css.map`, …, with or without a trailing query string). */
const SENSITIVE_PATH_RE = /^\/@fs\/|\.map(?:$|\?)/i

function splitUrl(raw: string): { path: string; search: string } {
  const qIdx = raw.indexOf("?")
  return qIdx === -1
    ? { path: raw, search: "" }
    : { path: raw.slice(0, qIdx), search: raw.slice(qIdx + 1) }
}

function readCookieToken(req: IncomingMessage): string | undefined {
  const header = req.headers.cookie
  if (!header) return undefined
  for (const part of header.split(";")) {
    const eq = part.indexOf("=")
    if (eq === -1) continue
    if (part.slice(0, eq).trim() === COOKIE_NAME) return part.slice(eq + 1).trim()
  }
  return undefined
}

export function createLinkGuard(opts: LinkGuardOptions): LinkGuard {
  const log = opts.onLog ?? ((): void => {})
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS

  let secret = randomBytes(32)
  let expiresAtMs = Date.now() + ttlMs
  let token = sign()
  let server: Server | null = null

  function sign(): string {
    return createHmac("sha256", secret).update(TOKEN_MESSAGE).digest("base64url")
  }

  function currentPort(): number {
    const addr = server?.address()
    return typeof addr === "object" && addr !== null ? addr.port : 0
  }

  function handle(): LinkGuardHandle {
    return { port: currentPort(), token, expiresAt: new Date(expiresAtMs).toISOString() }
  }

  function verify(candidate: string | undefined): boolean {
    if (!candidate) return false
    if (Date.now() >= expiresAtMs) return false
    const a = Buffer.from(candidate)
    const b = Buffer.from(token)
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  }

  function proxy(req: IncomingMessage, res: ServerResponse, pathAndSearch: string): void {
    const headers: Record<string, string | string[]> = {}
    for (const [key, value] of Object.entries(req.headers)) {
      if (value !== undefined) headers[key] = value
    }
    delete headers.cookie // never forward the guard's own cookie upstream
    headers.host = `${opts.target.host}:${opts.target.port}`

    const proxyReq = request(
      {
        hostname: opts.target.host,
        port: opts.target.port,
        path: pathAndSearch,
        method: req.method,
        headers,
      },
      proxyRes => {
        res.writeHead(proxyRes.statusCode ?? 502, {
          ...proxyRes.headers,
          "x-robots-tag": "noindex",
        })
        proxyRes.pipe(res)
      },
    )
    proxyReq.on("error", err => {
      log(`[link-guard] upstream error: ${err instanceof Error ? err.message : String(err)}`)
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "text/plain", "x-robots-tag": "noindex" })
        res.end("bad gateway")
      }
    })
    req.pipe(proxyReq)
  }

  function onRequest(req: IncomingMessage, res: ServerResponse): void {
    const rawUrl = req.url ?? "/"
    const { path, search } = splitUrl(rawUrl)

    if (SENSITIVE_PATH_RE.test(path)) {
      res.writeHead(403, { "content-type": "text/plain", "x-robots-tag": "noindex" })
      res.end("blocked: sensitive dev-server path")
      return
    }

    const query = new URLSearchParams(search)
    const queryToken = query.get(TOKEN_QUERY_PARAM) ?? undefined

    if (queryToken !== undefined && verify(queryToken)) {
      // Valid link on first hit: set the cookie, then redirect WITHOUT the
      // token in the URL so it never lingers in history or a Referer header.
      query.delete(TOKEN_QUERY_PARAM)
      const rest = query.toString()
      const location = path + (rest ? `?${rest}` : "")
      res.writeHead(303, {
        "set-cookie": `${COOKIE_NAME}=${queryToken}; Path=/; HttpOnly; Secure; SameSite=Lax`,
        location,
        "x-robots-tag": "noindex",
      })
      res.end()
      return
    }

    if (verify(readCookieToken(req))) {
      proxy(req, res, path + (search ? `?${search}` : ""))
      return
    }

    res.writeHead(403, { "content-type": "text/plain", "x-robots-tag": "noindex" })
    res.end("private preview — open the link you were given")
  }

  return {
    async start(): Promise<LinkGuardHandle> {
      server = createServer(onRequest)
      return new Promise((resolve, reject) => {
        server!.once("error", reject)
        server!.listen(0, "127.0.0.1", () => {
          log(
            `[link-guard] listening on 127.0.0.1:${currentPort()} -> ${opts.target.host}:${opts.target.port}`,
          )
          resolve(handle())
        })
      })
    },

    async stop(): Promise<void> {
      if (!server) return
      const toClose = server
      server = null
      await new Promise<void>((resolve, reject) => {
        toClose.close(err => (err ? reject(err) : resolve()))
      })
    },

    revoke(): LinkGuardHandle {
      secret = randomBytes(32)
      expiresAtMs = Date.now() + ttlMs
      token = sign()
      log("[link-guard] revoked — every previously issued link/cookie is now invalid")
      return handle()
    },
  }
}

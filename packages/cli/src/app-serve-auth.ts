/**
 * Access gate for `agentproto app serve` when it listens beyond loopback.
 *
 * Same shape as the daemon's gate for a shared link: the static shell (the page
 * and its assets) loads without a credential, so a phone can open it; every
 * `/__agentproto/*` route (tool calls, uploads) needs the access token, as
 * `Authorization: Bearer <token>` or as the cookie a first visit with
 * `?t=<token>` sets. Bound to loopback, nothing changes.
 */

import { randomBytes, createHash, timingSafeEqual } from "node:crypto"
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises"
import { dirname } from "node:path"
import type { IncomingMessage, ServerResponse } from "node:http"

export const ACCESS_COOKIE = "agentproto_app_serve"
/** Env var that can carry the token (never a flag value: argv is world-readable). */
export const ACCESS_TOKEN_ENV = "AGENTPROTO_APP_SERVE_TOKEN"
/** Routes that always need the token when a gate is active. */
const GUARDED_PREFIX = "/__agentproto/"
const COOKIE_MAX_AGE_S = 12 * 60 * 60

/** True for the loopback addresses (`127.0.0.0/8`, `::1`, `localhost`). */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "")
  return h === "localhost" || h === "::1" || /^127(\.\d{1,3}){3}$/.test(h)
}

/** 256 random bits, url-safe. */
export function newAccessToken(): string {
  return randomBytes(32).toString("base64url")
}

function digest(s: string): Buffer {
  return createHash("sha256").update(s).digest()
}

/** Constant-time string equality (compares fixed-length digests). */
export function tokensEqual(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b))
}

export interface ResolvedAccessToken {
  /** Undefined = no gate (loopback bind, or the operator opted out). */
  token?: string
  source: "none" | "env" | "file" | "generated"
  /** File a generated or file-sourced token lives in. */
  file?: string
}

/**
 * The token a non-loopback `app serve` enforces. Order: `--access-token-file`
 * (read; created with a fresh token when missing), then `AGENTPROTO_APP_SERVE_TOKEN`,
 * then a generated one written to `defaultFile` (mode 0600). Loopback binds and
 * `insecureNoAuth` get no gate.
 */
export async function resolveAccessToken(input: {
  host: string
  tokenFile?: string
  env?: NodeJS.ProcessEnv
  insecureNoAuth?: boolean
  defaultFile: string
}): Promise<ResolvedAccessToken> {
  if (input.insecureNoAuth || isLoopbackHost(input.host)) return { source: "none" }
  const fromEnv = (input.env ?? process.env)[ACCESS_TOKEN_ENV]?.trim()
  if (input.tokenFile === undefined && fromEnv) return { token: fromEnv, source: "env" }
  const file = input.tokenFile ?? input.defaultFile
  try {
    const existing = (await readFile(file, "utf8")).trim()
    if (existing.length >= 16) return { token: existing, source: "file", file }
  } catch {
    // missing or unreadable: create it below
  }
  const token = newAccessToken()
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, `${token}\n`, { encoding: "utf8", mode: 0o600 })
  await chmod(file, 0o600)
  return { token, source: "generated", file }
}

function bearerOf(req: IncomingMessage): string | undefined {
  const h = req.headers.authorization
  const m = typeof h === "string" ? /^Bearer\s+(.+)$/i.exec(h.trim()) : null
  return m?.[1]
}

function cookieOf(req: IncomingMessage): string | undefined {
  const raw = req.headers.cookie
  if (typeof raw !== "string") return undefined
  for (const part of raw.split(";")) {
    const i = part.indexOf("=")
    if (i > 0 && part.slice(0, i).trim() === ACCESS_COOKIE) return part.slice(i + 1).trim()
  }
  return undefined
}

/** Does the request carry the token (bearer or cookie)? */
export function hasAccess(req: IncomingMessage, token: string): boolean {
  const presented = bearerOf(req) ?? cookieOf(req)
  return presented !== undefined && tokensEqual(presented, token)
}

function isHttps(req: IncomingMessage): boolean {
  const xfp = req.headers["x-forwarded-proto"]
  const proto = typeof xfp === "string" ? xfp.split(",")[0]!.trim().toLowerCase() : undefined
  return proto === "https" || (req.socket as { encrypted?: boolean }).encrypted === true
}

/**
 * Apply the gate. Returns true when the request was answered here (a 401, or
 * the redirect that trades `?t=` for the cookie) and the caller must stop.
 */
export function enforceAccess(req: IncomingMessage, res: ServerResponse, token: string): boolean {
  const url = new URL(req.url ?? "/", "http://localhost")
  const method = req.method ?? "GET"
  const presentedInUrl = url.searchParams.get("t")
  if ((method === "GET" || method === "HEAD") && presentedInUrl !== null) {
    if (tokensEqual(presentedInUrl, token)) {
      // Trade the link token for a cookie and drop it from the address bar.
      url.searchParams.delete("t")
      res.writeHead(303, {
        location: `${url.pathname}${url.search}`,
        "set-cookie":
          `${ACCESS_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE_S}` +
          (isHttps(req) ? "; Secure" : ""),
        "cache-control": "no-store",
      })
      res.end()
      return true
    }
  }
  if (url.pathname.startsWith(GUARDED_PREFIX) && !hasAccess(req, token)) {
    res.writeHead(401, {
      "content-type": "application/json",
      "www-authenticate": 'Bearer realm="agentproto-app-serve"',
      "cache-control": "no-store",
    })
    res.end(JSON.stringify({ error: "unauthorized" }))
    return true
  }
  return false
}

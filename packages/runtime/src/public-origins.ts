import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import type { IncomingHttpHeaders } from "node:http"

const HTTP_PROTOCOLS = new Set(["http:", "https:"])
const WS_PROTOCOLS = new Set(["ws:", "wss:"])

/**
 * Header the daemon itself sets, on a request it forwards to its own gateway,
 * to say "the public base of this request is X" (pairing path, link-guard).
 * The value is HMAC-signed with a per-process key, so a client that sends its
 * own copy cannot make the gateway believe a base it did not set: an unsigned
 * or foreign-signed value is ignored, and the daemon strips client copies at
 * every place it injects one.
 */
export const PUBLIC_BASE_HEADER = "x-agentproto-public-base"

export type PublicBaseSource = "env" | "trusted-header" | "forwarded" | "host" | "loopback"

export interface PublicBase {
  /** `scheme://host[:port]`, no path. */
  origin: string
  /** `""` or a path such as `/d/<fingerprint>` (no trailing slash). */
  pathPrefix: string
  /** `origin + pathPrefix`: what a page should resolve its links against. */
  baseUrl: string
  source: PublicBaseSource
}

const SIGNING_KEY = randomBytes(32)

function mac(payload: string): Buffer {
  return createHmac("sha256", SIGNING_KEY).update(payload).digest()
}

/** Parse `scheme://host[:port][/prefix]`; undefined when it is not a plain base. */
function parseBase(
  value: string | undefined,
  protocols: ReadonlySet<string>,
  allowPath: boolean,
): { origin: string; pathPrefix: string } | undefined {
  const candidate = value?.trim().replace(/\/+$/, "")
  if (!candidate) return undefined
  try {
    const url = new URL(candidate)
    if (!protocols.has(url.protocol)) return undefined
    if (url.username || url.password || url.search || url.hash) return undefined
    const path = url.pathname.replace(/\/+$/, "")
    if (path && !allowPath) return undefined
    return { origin: url.origin, pathPrefix: path }
  } catch {
    return undefined
  }
}

function makeBase(
  parsed: { origin: string; pathPrefix: string },
  source: PublicBaseSource,
): PublicBase {
  return { ...parsed, baseUrl: parsed.origin + parsed.pathPrefix, source }
}

/** Sign a public base for `PUBLIC_BASE_HEADER`. Throws on a value that is not an http(s) base. */
export function signPublicBase(base: string): string {
  const parsed = parseBase(base, HTTP_PROTOCOLS, true)
  if (!parsed) throw new Error(`signPublicBase: not an http(s) base URL: ${base}`)
  const payload = Buffer.from(parsed.origin + parsed.pathPrefix, "utf8").toString("base64url")
  return `${payload}.${mac(payload).toString("base64url")}`
}

function verifyPublicBase(value: string | string[] | undefined): PublicBase | undefined {
  if (typeof value !== "string") return undefined
  const [payload, signature, ...rest] = value.split(".")
  if (!payload || !signature || rest.length > 0) return undefined
  const expected = mac(payload)
  const given = Buffer.from(signature, "base64url")
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined
  const parsed = parseBase(Buffer.from(payload, "base64url").toString("utf8"), HTTP_PROTOCOLS, true)
  return parsed ? makeBase(parsed, "trusted-header") : undefined
}

function firstValue(value: string | string[] | undefined): string | undefined {
  return (Array.isArray(value) ? value[0] : value)?.split(",")[0]?.trim() || undefined
}

function isLoopbackHost(host: string): boolean {
  let hostname: string
  try {
    hostname = new URL(`http://${host}`).hostname.toLowerCase()
  } catch {
    return false
  }
  return (
    hostname === "localhost" ||
    hostname === "[::1]" ||
    hostname === "0.0.0.0" ||
    /^127\.\d+\.\d+\.\d+$/.test(hostname)
  )
}

/**
 * Scheme to assume for a host that a proxy forwarded without X-Forwarded-Proto.
 * A proxy that rewrites Host to the daemon and says only where the client went
 * (X-Forwarded-Host: abc.trycloudflare.com) is a TLS-terminating edge in
 * practice; guessing http there produced mixed-content links on an https page.
 * So a DNS name defaults to https. Hosts that cannot carry a public certificate
 * stay http: localhost, *.localhost, *.local, IP literals and single-label
 * names. An explicit X-Forwarded-Proto always wins over this default.
 */
function defaultProtoForHost(host: string): "http" | "https" {
  let hostname: string
  try {
    hostname = new URL(`http://${host}`).hostname.toLowerCase()
  } catch {
    return "http"
  }
  if (hostname.startsWith("[")) return "http"
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) return "http"
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    return "http"
  }
  return hostname.includes(".") ? "https" : "http"
}

/**
 * Resolve the public base (origin + optional path prefix) one request was
 * reached at. Order, first match wins:
 *
 *  1. `configuredOrigin` (env `AGENTPROTO_PUBLIC_HTTP_ORIGIN`), prefix allowed.
 *  2. `PUBLIC_BASE_HEADER`, set by the daemon on the pairing path and by
 *     link-guard; only a validly signed value counts.
 *  3. `X-Forwarded-Host` (first value) with `X-Forwarded-Proto`, or the host
 *     default (https for a DNS name, see `defaultProtoForHost`) when absent.
 *  4. a non-loopback `Host`, with `X-Forwarded-Proto` if present, else http.
 *  5. the loopback `Host` (or `127.0.0.1` when there is none).
 *
 * `X-Forwarded-Prefix` and RFC 7239 `Forwarded` are not read.
 */
export function resolvePublicBase(
  headers: IncomingHttpHeaders,
  configuredOrigin: string | undefined = process.env.AGENTPROTO_PUBLIC_HTTP_ORIGIN,
): PublicBase {
  const configured = parseBase(configuredOrigin, HTTP_PROTOCOLS, true)
  if (configured) return makeBase(configured, "env")

  const trusted = verifyPublicBase(headers[PUBLIC_BASE_HEADER])
  if (trusted) return trusted

  const forwardedProto = firstValue(headers["x-forwarded-proto"])?.toLowerCase()
  const explicitProto =
    forwardedProto === "https" || forwardedProto === "http" ? forwardedProto : undefined

  const forwardedHost = firstValue(headers["x-forwarded-host"])
  if (forwardedHost) {
    const proto = explicitProto ?? defaultProtoForHost(forwardedHost)
    const parsed = parseBase(`${proto}://${forwardedHost}`, HTTP_PROTOCOLS, false)
    if (parsed) return makeBase(parsed, isLoopbackHost(forwardedHost) ? "loopback" : "forwarded")
  }

  const host = typeof headers.host === "string" ? headers.host.trim() : undefined
  if (host) {
    const parsed = parseBase(`${explicitProto ?? "http"}://${host}`, HTTP_PROTOCOLS, false)
    if (parsed) return makeBase(parsed, isLoopbackHost(host) ? "loopback" : "host")
  }

  return makeBase({ origin: `${explicitProto ?? "http"}://127.0.0.1`, pathPrefix: "" }, "loopback")
}

/** The base URL of one request: `resolvePublicBase(...).baseUrl`. */
export function resolveRequestHttpBaseUrl(
  headers: IncomingHttpHeaders,
  configuredOrigin: string | undefined = process.env.AGENTPROTO_PUBLIC_HTTP_ORIGIN,
): string {
  return resolvePublicBase(headers, configuredOrigin).baseUrl
}

/**
 * The PTY WebSocket base that goes with an HTTP base: the explicit
 * `AGENTPROTO_PUBLIC_WS_ORIGIN` when valid, else the HTTP base with its scheme
 * swapped (http to ws, https to wss), prefix kept.
 */
export function deriveWsBaseUrl(
  httpBaseUrl: string,
  configuredWsOrigin: string | undefined = process.env.AGENTPROTO_PUBLIC_WS_ORIGIN,
): string {
  const configured = parseBase(configuredWsOrigin, WS_PROTOCOLS, true)
  if (configured) return configured.origin + configured.pathPrefix
  return httpBaseUrl.replace(/^http(s?):/, (_m, s: string) => `ws${s}:`)
}

/** Resolve the public HTTP + PTY WebSocket bases used at gateway boot. */
export function resolvePublicAppOrigins(
  port: number,
  configuredHttpOrigin = process.env.AGENTPROTO_PUBLIC_HTTP_ORIGIN,
  configuredWsOrigin = process.env.AGENTPROTO_PUBLIC_WS_ORIGIN,
): { httpOrigin: string; wsOrigin: string } {
  const parsed = parseBase(configuredHttpOrigin, HTTP_PROTOCOLS, true)
  const httpOrigin = parsed ? parsed.origin + parsed.pathPrefix : `http://127.0.0.1:${port}`
  return { httpOrigin, wsOrigin: deriveWsBaseUrl(httpOrigin, configuredWsOrigin) }
}

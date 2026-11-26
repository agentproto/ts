import { lookup } from "node:dns/promises"
import http from "node:http"
import https from "node:https"
import { isIP } from "node:net"
import type { DriverHandle, ExecuteFn } from "@agentproto/driver"

/** Internal driverCtx keys injected by `safeHttpCollector` for `defineHttpDriver`. */
export const SAFE_HTTP_FETCH_KEY = "__agentprotoSafeFetch" as const
export const SAFE_HTTP_EXTRA_HEADERS_KEY = "__agentprotoExtraHeaders" as const

export const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576 // 1 MiB
export const DEFAULT_TIMEOUT_MS = 15_000 // 15 s
export const DEFAULT_MIN_REDACT_LENGTH = 6

export interface DnsAddressRecord {
  address: string
  family: number
}

export type DnsLookupFn = (hostname: string) => Promise<DnsAddressRecord[]>

export interface SafeHttpCollectorOptions {
  /** Maximum response payload in bytes (default: 1 MiB). */
  maxResponseBytes?: number
  /** Request timeout in milliseconds (default: 15_000). */
  timeoutMs?: number
  /**
   * Optional underlying fetch implementation (for tests or custom dispatchers).
   * When omitted, requests use a built-in Node HTTP/HTTPS client pinned to the
   * pre-validated IP address to prevent DNS rebinding (TOCTOU).
   */
  fetch?: typeof globalThis.fetch
  /** Custom DNS resolver for testing (default: node:dns/promises lookup all). */
  dnsLookup?: DnsLookupFn
  /**
   * Permit `http:` scheme (default: false — HTTPS only).
   * Even when enabled, private/loopback/link-local/NAT64/6to4 IPs remain blocked.
   */
  allowHttp?: boolean
  /**
   * Minimum length of secret strings scrubbed from errors (default: 6) so very
   * short strings do not mangle unrelated error text.
   */
  minRedactLength?: number
  /**
   * Additional secret values to scrub from thrown error messages and stacks.
   * All values in `driverCtx.secrets` are always scrubbed automatically.
   */
  extraSecretsToRedact?: readonly string[]
}

export class SafeHttpCollectorError extends Error {
  code: string
  retryable: boolean
  constructor(code: string, message: string, retryable = false) {
    super(message)
    this.name = "SafeHttpCollectorError"
    this.code = code
    this.retryable = retryable
  }
}

/**
 * Scrub secret values (length >= `minLength`, default 6) from text before logging or throwing.
 */
export function redactSecrets(
  text: string,
  secrets: Record<string, string> | readonly string[] | undefined,
  minLength = DEFAULT_MIN_REDACT_LENGTH,
): string {
  if (!text || !secrets) return text
  const values = Array.isArray(secrets) ? secrets : Object.values(secrets)
  const sorted = [
    ...new Set(
      values.filter((v): v is string => typeof v === "string" && v.length >= minLength),
    ),
  ].sort((a, b) => b.length - a.length)
  let out = text
  for (const secret of sorted) {
    if (out.includes(secret)) {
      out = out.split(secret).join("[REDACTED]")
    }
  }
  return out
}

function parseIpv4ToInt(ip: string): number | undefined {
  const parts = ip.split(".")
  if (parts.length !== 4) return undefined
  let value = 0
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return undefined
    const n = Number(part)
    if (n < 0 || n > 255) return undefined
    value = (value << 8) | n
  }
  return value >>> 0
}

function isPrivateOrReservedIpv4Int(n: number): boolean {
  const a = (n >>> 24) & 0xff
  const b = (n >>> 16) & 0xff
  const c = (n >>> 8) & 0xff
  // 0.0.0.0/8 (this network)
  if (a === 0) return true
  // 10.0.0.0/8 (RFC1918)
  if (a === 10) return true
  // 100.64.0.0/10 (CGNAT / RFC6598)
  if (a === 100 && b >= 64 && b <= 127) return true
  // 127.0.0.0/8 (loopback)
  if (a === 127) return true
  // 169.254.0.0/16 (link-local & cloud metadata 169.254.169.254)
  if (a === 169 && b === 254) return true
  // 172.16.0.0/12 (RFC1918)
  if (a === 172 && b >= 16 && b <= 31) return true
  // 192.0.0.0/24, 192.0.2.0/24, 192.168.0.0/16
  if (a === 192 && b === 168) return true
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true
  // 198.18.0.0/15 (benchmarking)
  if (a === 198 && (b === 18 || b === 19)) return true
  // 198.51.100.0/24, 203.0.113.0/24 (TEST-NET)
  if (a === 198 && b === 51 && c === 100) return true
  if (a === 203 && b === 0 && c === 113) return true
  // 224.0.0.0/4 (multicast) and 240.0.0.0/4 (reserved/broadcast)
  if (a >= 224) return true
  return false
}

function isPrivateOrReservedIpv4(ip: string): boolean {
  const n = parseIpv4ToInt(ip)
  if (n === undefined) return true
  return isPrivateOrReservedIpv4Int(n)
}

/**
 * Parse any valid IPv6 address (compressed `::`, expanded, or mixed IPv4-tail)
 * into 8 unsigned 16-bit hextets. Returns undefined on malformed input.
 */
function parseIpv6Hextets(raw: string): number[] | undefined {
  let s = raw
  // Handle mixed IPv4 tail (e.g. ::ffff:169.254.169.254 or 64:ff9b::127.0.0.1)
  const lastColon = s.lastIndexOf(":")
  if (lastColon !== -1 && s.slice(lastColon + 1).includes(".")) {
    const v4Int = parseIpv4ToInt(s.slice(lastColon + 1))
    if (v4Int === undefined) return undefined
    const hi = ((v4Int >>> 16) & 0xffff).toString(16)
    const lo = (v4Int & 0xffff).toString(16)
    s = `${s.slice(0, lastColon + 1)}${hi}:${lo}`
  }

  const halves = s.split("::")
  if (halves.length > 2) return undefined

  const parsePart = (part: string): number[] | undefined => {
    if (!part) return []
    const tokens = part.split(":")
    const nums: number[] = []
    for (const tok of tokens) {
      if (!/^[0-9a-f]{1,4}$/.test(tok)) return undefined
      nums.push(Number.parseInt(tok, 16))
    }
    return nums
  }

  if (halves.length === 1) {
    const full = parsePart(halves[0]!)
    return full && full.length === 8 ? full : undefined
  }

  const left = parsePart(halves[0]!)
  const right = parsePart(halves[1]!)
  if (!left || !right) return undefined
  const missing = 8 - left.length - right.length
  if (missing < 1) return undefined
  return [...left, ...new Array<number>(missing).fill(0), ...right]
}

/**
 * Returns true if an IPv4 or IPv6 address belongs to a loopback, private,
 * link-local, metadata, CGNAT, multicast, NAT64, 6to4, IPv4-compatible,
 * IPv4-mapped, Teredo, or reserved range. Fails closed on unparseable inputs.
 */
export function isPrivateOrReservedIp(rawIp: string): boolean {
  const ip = rawIp.trim().toLowerCase().replace(/^\[|\]$/g, "")
  const zoneIdx = ip.indexOf("%")
  const clean = zoneIdx === -1 ? ip : ip.slice(0, zoneIdx)

  const family = isIP(clean)
  if (family === 4) return isPrivateOrReservedIpv4(clean)
  if (family === 6) {
    const h = parseIpv6Hextets(clean)
    if (!h) return true
    const [h0, h1, h2, h3, h4, h5, h6, h7] = h as [
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ]

    // ::/96 — unspecified (::), loopback (::1), and deprecated IPv4-compatible (::a.b.c.d)
    if (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0) {
      return true
    }
    // ::ffff:0:0/96 (IPv4-mapped) — handles both compressed and expanded forms
    if (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0xffff) {
      return isPrivateOrReservedIpv4Int(((h6 << 16) | h7) >>> 0)
    }
    // ::ffff:0:0:0/96 (IPv4-translated, RFC 2765)
    if (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0xffff && h5 === 0) {
      return true
    }
    // 64:ff9b::/96 (NAT64 well-known prefix, RFC 6052) and 64:ff9b:1::/48 (NAT64 local-use, RFC 8215)
    if (h0 === 0x0064 && h1 === 0xff9b) {
      if (h2 === 1) return true
      if (h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0) return true
    }
    // 2002::/16 (6to4 — embeds IPv4 in h1:h2; deprecated SSRF vector, fail closed)
    if (h0 === 0x2002) return true
    // 2001:0000::/32 (Teredo) and 2001:db8::/32 (documentation)
    if (h0 === 0x2001 && (h1 === 0x0000 || h1 === 0x0db8)) return true
    // 100::/64 (discard-only)
    if (h0 === 0x0100 && h1 === 0 && h2 === 0 && h3 === 0) return true
    // fc00::/7 (Unique Local Addresses)
    if ((h0 & 0xfe00) === 0xfc00) return true
    // fe80::/10 (Link-Local) and fec0::/10 (deprecated Site-Local)
    if ((h0 & 0xffc0) === 0xfe80 || (h0 & 0xffc0) === 0xfec0) return true
    // ff00::/8 (Multicast)
    if ((h0 & 0xff00) === 0xff00) return true

    return false
  }
  return true
}

const BLOCKED_HOST_SUFFIXES = [".local", ".internal", ".localhost", ".localdomain"]

export interface ValidatedSafeUrl {
  url: URL
  addresses: DnsAddressRecord[]
}

/**
 * Lexical URL validation + DNS resolution anti-SSRF guard.
 * Returns the parsed URL along with the validated IP records so callers can pin
 * the TCP connection to a pre-validated address and prevent DNS rebinding.
 */
export async function assertSafeUrl(
  rawUrl: string,
  opts: { allowHttp?: boolean; dnsLookup?: DnsLookupFn } = {},
): Promise<ValidatedSafeUrl> {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new SafeHttpCollectorError("ssrf_blocked", `Invalid URL '${rawUrl}'.`)
  }

  const allowedProtocols = opts.allowHttp ? ["https:", "http:"] : ["https:"]
  if (!allowedProtocols.includes(url.protocol)) {
    throw new SafeHttpCollectorError(
      "ssrf_blocked",
      `Protocol '${url.protocol}' is not allowed (only ${allowedProtocols.join(", ")}).`,
    )
  }

  if (url.username || url.password) {
    throw new SafeHttpCollectorError(
      "ssrf_blocked",
      "URLs with embedded userinfo credentials are not allowed.",
    )
  }

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "")
  if (!hostname || hostname === "localhost" || BLOCKED_HOST_SUFFIXES.some((s) => hostname.endsWith(s))) {
    throw new SafeHttpCollectorError(
      "ssrf_blocked",
      `Host '${hostname}' is blocked by SSRF policy.`,
    )
  }

  const literalFamily = isIP(hostname)
  if (literalFamily !== 0) {
    if (isPrivateOrReservedIp(hostname)) {
      throw new SafeHttpCollectorError(
        "ssrf_blocked",
        `IP address '${hostname}' is in a private, loopback, link-local, or reserved range.`,
      )
    }
    return { url, addresses: [{ address: hostname, family: literalFamily }] }
  }

  const resolveDns: DnsLookupFn =
    opts.dnsLookup ??
    (async (host) => {
      const records = await lookup(host, { all: true })
      return records.map((r) => ({ address: r.address, family: r.family }))
    })

  let addresses: DnsAddressRecord[]
  try {
    addresses = await resolveDns(hostname)
  } catch (err) {
    throw new SafeHttpCollectorError(
      "ssrf_blocked",
      `DNS lookup failed for '${hostname}': ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  if (!addresses || addresses.length === 0) {
    throw new SafeHttpCollectorError(
      "ssrf_blocked",
      `DNS lookup returned no addresses for '${hostname}'.`,
    )
  }

  for (const rec of addresses) {
    if (isPrivateOrReservedIp(rec.address)) {
      throw new SafeHttpCollectorError(
        "ssrf_blocked",
        `Host '${hostname}' resolved to blocked address '${rec.address}'.`,
      )
    }
  }

  return { url, addresses }
}

/**
 * Create a Node `net.Socket` / `http.request` `lookup` callback pinned strictly
 * to the pre-validated DNS record(s) from {@link assertSafeUrl}. Re-checks the
 * address before handing it to the socket so DNS rebinding cannot occur between
 * validation and connect.
 */
export function createPinnedLookup(
  addresses: readonly DnsAddressRecord[],
): NonNullable<http.RequestOptions["lookup"]> {
  const chosen = addresses[0]
  if (!chosen || isPrivateOrReservedIp(chosen.address)) {
    throw new SafeHttpCollectorError("ssrf_blocked", "No safe pre-validated IP address available to pin.")
  }
  return ((
    _hostname: string,
    options: unknown,
    callback?: (err: NodeJS.ErrnoException | null, address: string | DnsAddressRecord[], family?: number) => void,
  ) => {
    const cb = typeof options === "function" ? (options as typeof callback) : callback
    if (!cb) return
    const opts = typeof options === "object" && options !== null ? (options as { all?: boolean }) : {}
    if (opts.all) {
      cb(null, addresses.map((a) => ({ address: a.address, family: a.family })))
    } else {
      cb(null, chosen.address, chosen.family)
    }
  }) as unknown as NonNullable<http.RequestOptions["lookup"]>
}

function normalizeHeadersToRecord(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {}
  if (headers instanceof Headers) {
    const out: Record<string, string> = {}
    headers.forEach((v, k) => {
      out[k] = v
    })
    return out
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers.map(([k, v]) => [k, String(v)]))
  }
  return { ...(headers as Record<string, string>) }
}

/**
 * Execute a GET request using Node's `http`/`https` client pinned to the
 * pre-validated IP addresses (preventing DNS rebinding), with streaming byte cap,
 * redirect refusal, and AbortSignal support.
 */
function pinnedNodeGet(
  url: URL,
  addresses: readonly DnsAddressRecord[],
  headers: Record<string, string>,
  signal: AbortSignal,
  maxBytes: number,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const client = url.protocol === "https:" ? https : http
    const pinnedLookup = createPinnedLookup(addresses)

    const bareHost = url.hostname.replace(/^\[|\]$/g, "")
    const hasAcceptEncoding = Object.keys(headers).some((k) => k.toLowerCase() === "accept-encoding")
    const reqHeaders = hasAcceptEncoding ? headers : { ...headers, "accept-encoding": "identity" }

    const req = client.request(
      url,
      {
        method: "GET",
        headers: reqHeaders,
        lookup: pinnedLookup,
        ...(url.protocol === "https:" && isIP(bareHost) === 0 ? { servername: bareHost } : {}),
        signal,
      },
      (res) => {
        const status = res.statusCode ?? 0
        const statusText = res.statusMessage ?? ""
        const resHeaders = new Headers()
        for (const [k, v] of Object.entries(res.headers)) {
          if (v === undefined) continue
          if (Array.isArray(v)) {
            for (const item of v) resHeaders.append(k, item)
          } else {
            resHeaders.set(k, v)
          }
        }

        if (status >= 300 && status < 400) {
          res.destroy()
          reject(
            new SafeHttpCollectorError(
              "redirect_blocked",
              `HTTP redirect (${status}) refused by safeHttpCollector.`,
            ),
          )
          return
        }

        const cl = resHeaders.get("content-length")
        if (cl) {
          const declared = Number.parseInt(cl, 10)
          if (!Number.isNaN(declared) && declared > maxBytes) {
            res.destroy()
            reject(
              new SafeHttpCollectorError(
                "response_too_large",
                `Response Content-Length ${declared} exceeds ceiling of ${maxBytes} bytes.`,
              ),
            )
            return
          }
        }

        const chunks: Buffer[] = []
        let total = 0
        res.on("data", (chunk: Buffer) => {
          total += chunk.byteLength
          if (total > maxBytes) {
            res.destroy()
            reject(
              new SafeHttpCollectorError(
                "response_too_large",
                `Response body exceeded ceiling of ${maxBytes} bytes while streaming.`,
              ),
            )
            return
          }
          chunks.push(chunk)
        })
        res.on("end", () => {
          const out = new Response(Buffer.concat(chunks, total), {
            status,
            statusText,
            headers: resHeaders,
          })
          Object.defineProperty(out, "url", { value: url.toString(), configurable: true })
          resolve(out)
        })
        res.on("error", reject)
      },
    )

    req.on("error", reject)
    req.end()
  })
}

async function readBoundedBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  const contentLengthHeader = response.headers.get("content-length")
  if (contentLengthHeader) {
    const declared = Number.parseInt(contentLengthHeader, 10)
    if (!Number.isNaN(declared) && declared > maxBytes) {
      await response.body?.cancel().catch(() => {})
      throw new SafeHttpCollectorError(
        "response_too_large",
        `Response Content-Length ${declared} exceeds ceiling of ${maxBytes} bytes.`,
      )
    }
  }

  if (!response.body) {
    const buf = new Uint8Array(await response.arrayBuffer())
    if (buf.byteLength > maxBytes) {
      throw new SafeHttpCollectorError(
        "response_too_large",
        `Response size ${buf.byteLength} exceeds ceiling of ${maxBytes} bytes.`,
      )
    }
    return buf
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        total += value.byteLength
        if (total > maxBytes) {
          await reader.cancel().catch(() => {})
          throw new SafeHttpCollectorError(
            "response_too_large",
            `Response body exceeded ceiling of ${maxBytes} bytes while streaming.`,
          )
        }
        chunks.push(value)
      }
    }
  } finally {
    reader.releaseLock()
  }

  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

function isJsonContentType(contentType: string): boolean {
  const mime = contentType.split(";")[0]?.trim().toLowerCase() ?? ""
  return mime === "application/json" || mime.endsWith("+json")
}

/**
 * Create a guarded read-only JSON `fetch` implementation for bounded metric/API
 * collectors (non-streaming; SSE/plain-text endpoints are deliberately refused):
 * - GET-only method
 * - Lexical + DNS anti-SSRF checks with pinned-IP Node transport (prevents DNS rebinding)
 * - `redirect: "error"`
 * - Timeout via `AbortSignal.timeout`
 * - Streaming response size ceiling (default 1 MiB)
 * - JSON `content-type` validation on 2xx responses
 * - Preserves `response.url` on returned `Response`
 */
export function createSafeCollectorFetch(
  opts: SafeHttpCollectorOptions = {},
): typeof globalThis.fetch {
  const maxResponseBytes = opts.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS

  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const rawUrl =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase()

    if (method !== "GET") {
      throw new SafeHttpCollectorError(
        "method_not_allowed",
        `safeHttpCollector only allows GET requests (refused '${method}').`,
      )
    }

    const { url, addresses } = await assertSafeUrl(rawUrl, {
      allowHttp: opts.allowHttp,
      dnsLookup: opts.dnsLookup,
    })

    const timeoutSignal = AbortSignal.timeout(timeoutMs)
    const combinedSignal = init?.signal
      ? AbortSignal.any([init.signal, timeoutSignal])
      : timeoutSignal

    let out: Response
    if (opts.fetch) {
      const response = await opts.fetch(url.toString(), {
        ...init,
        method: "GET",
        body: undefined,
        redirect: "error",
        signal: combinedSignal,
      })

      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => {})
        throw new SafeHttpCollectorError(
          "redirect_blocked",
          `HTTP redirect (${response.status}) refused by safeHttpCollector.`,
        )
      }

      const bytes = await readBoundedBytes(response, maxResponseBytes)
      out = new Response(Buffer.from(bytes), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      })
      Object.defineProperty(out, "url", {
        value: response.url || url.toString(),
        configurable: true,
      })
    } else {
      const headers = normalizeHeadersToRecord(init?.headers)
      out = await pinnedNodeGet(url, addresses, headers, combinedSignal, maxResponseBytes)
    }

    if (out.status >= 200 && out.status < 300) {
      const ct = out.headers.get("content-type") ?? ""
      if (!isJsonContentType(ct)) {
        throw new SafeHttpCollectorError(
          "invalid_content_type",
          `Expected JSON content-type from safeHttpCollector, received '${ct || "(none)"}'.`,
        )
      }
    }

    return out
  }) as typeof globalThis.fetch
}

interface MetricSourceAuthMeta {
  headerName?: string
  prefix?: string
}

function readDriverAuthSpec(driver: DriverHandle): {
  secretRef?: string
  headerName: string
  prefix: string
} | undefined {
  const authEnv = (driver.auth as { state?: { env?: unknown } } | undefined)?.state?.env
  const secretRef =
    Array.isArray(authEnv) && typeof authEnv[0] === "string" && authEnv[0].length > 0
      ? authEnv[0]
      : undefined
  const metricSource = (
    driver.metadata as { metricSource?: { auth?: MetricSourceAuthMeta } } | undefined
  )?.metricSource
  if (!secretRef || !metricSource?.auth) return undefined
  return {
    secretRef,
    headerName: metricSource.auth.headerName || "Authorization",
    prefix: metricSource.auth.prefix ?? "Bearer ",
  }
}

/**
 * Wrap a {@link DriverHandle}'s `execute` map so every invocation goes through
 * the single guarded read-only JSON HTTP path (`createSafeCollectorFetch`),
 * composes the single authentication header from `auth.state.env[0]` +
 * `metadata.metricSource.auth`, and scrubs all secrets from thrown error
 * messages and stacks.
 *
 * Scoped strictly to bounded JSON read-only sources: drivers declaring
 * `metadata.http.streaming` are refused because streaming transports cannot
 * be bounded/validated as a single JSON payload.
 */
export function safeHttpCollector(
  driver: DriverHandle,
  opts: SafeHttpCollectorOptions = {},
): DriverHandle {
  const httpMeta = (driver.metadata as { http?: { streaming?: unknown } } | undefined)?.http
  if (httpMeta?.streaming) {
    throw new SafeHttpCollectorError(
      "streaming_unsupported",
      `driver '${driver.id}': safeHttpCollector only supports bounded JSON GET responses, not streaming transports.`,
    )
  }

  const safeFetch = createSafeCollectorFetch(opts)
  const authSpec = readDriverAuthSpec(driver)
  const minRedactLength = opts.minRedactLength ?? DEFAULT_MIN_REDACT_LENGTH

  const wrappedExecute: Record<string, ExecuteFn> = {}
  for (const [toolId, originalFn] of Object.entries(driver.execute)) {
    wrappedExecute[toolId] = async (args) => {
      const driverCtx = args.driverCtx as {
        secrets?: Record<string, string>
        [k: string]: unknown
      }
      const secrets = driverCtx.secrets ?? {}

      const extraHeaders: Record<string, string> = {}
      if (authSpec?.secretRef) {
        const secretValue = secrets[authSpec.secretRef]
        if (!secretValue) {
          throw new SafeHttpCollectorError(
            "missing_secret",
            `driver '${driver.id}': missing required secret '${authSpec.secretRef}' in driverCtx.secrets.`,
          )
        }
        extraHeaders[authSpec.headerName] = `${authSpec.prefix}${secretValue}`
      }

      const nextCtx = {
        ...args.driverCtx,
        [SAFE_HTTP_FETCH_KEY]: safeFetch,
        ...(Object.keys(extraHeaders).length > 0
          ? { [SAFE_HTTP_EXTRA_HEADERS_KEY]: extraHeaders }
          : {}),
      }

      try {
        return await originalFn({ ...args, driverCtx: nextCtx })
      } catch (err) {
        const allSecrets = [
          ...Object.values(secrets),
          ...(opts.extraSecretsToRedact ?? []),
        ]
        if (err instanceof Error) {
          const scrubbedMsg = redactSecrets(err.message, allSecrets, minRedactLength)
          if (scrubbedMsg !== err.message) {
            err.message = scrubbedMsg
          }
          if (typeof err.stack === "string") {
            const scrubbedStack = redactSecrets(err.stack, allSecrets, minRedactLength)
            if (scrubbedStack !== err.stack) {
              err.stack = scrubbedStack
            }
          }
        }
        throw err
      }
    }
  }

  return Object.freeze({
    ...driver,
    execute: Object.freeze(wrappedExecute),
  })
}

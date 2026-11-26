import { lookup } from "node:dns/promises"
import { isIP } from "node:net"
import type { DriverHandle, ExecuteFn } from "@agentproto/driver"

/** Internal driverCtx keys injected by `safeHttpCollector` for `defineHttpDriver`. */
export const SAFE_HTTP_FETCH_KEY = "__agentprotoSafeFetch" as const
export const SAFE_HTTP_EXTRA_HEADERS_KEY = "__agentprotoExtraHeaders" as const

export const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576 // 1 MiB
export const DEFAULT_TIMEOUT_MS = 15_000 // 15 s

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
  /** Underlying fetch implementation (default: globalThis.fetch). */
  fetch?: typeof globalThis.fetch
  /** Custom DNS resolver for testing (default: node:dns/promises lookup all). */
  dnsLookup?: DnsLookupFn
  /**
   * Permit `http:` scheme (default: false — HTTPS only).
   * Even when enabled, private/loopback/link-local IPs remain blocked.
   */
  allowHttp?: boolean
  /**
   * Additional secret values to scrub from thrown error messages.
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
 * Scrub every non-empty secret value from a text string before logging or throwing.
 */
export function redactSecrets(
  text: string,
  secrets: Record<string, string> | readonly string[] | undefined,
): string {
  if (!text || !secrets) return text
  const values = Array.isArray(secrets) ? secrets : Object.values(secrets)
  // Replace longest secrets first to avoid partial substring leakage.
  const sorted = [...new Set(values.filter((v): v is string => typeof v === "string" && v.length > 0))]
    .sort((a, b) => b.length - a.length)
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

function isPrivateOrReservedIpv4(ip: string): boolean {
  const n = parseIpv4ToInt(ip)
  if (n === undefined) return true
  const a = (n >>> 24) & 0xff
  const b = (n >>> 16) & 0xff
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
  if (a === 192 && b === 0 && ((n >>> 8) & 0xff) === 0) return true
  if (a === 192 && b === 0 && ((n >>> 8) & 0xff) === 2) return true
  // 198.18.0.0/15 (benchmarking)
  if (a === 198 && (b === 18 || b === 19)) return true
  // 198.51.100.0/24, 203.0.113.0/24 (TEST-NET)
  if (a === 198 && b === 51 && ((n >>> 8) & 0xff) === 100) return true
  if (a === 203 && b === 0 && ((n >>> 8) & 0xff) === 113) return true
  // 224.0.0.0/4 (multicast) and 240.0.0.0/4 (reserved/broadcast)
  if (a >= 224) return true
  return false
}

/**
 * Returns true if an IPv4 or IPv6 address belongs to a loopback, private,
 * link-local, metadata, CGNAT, multicast, or reserved range.
 */
export function isPrivateOrReservedIp(rawIp: string): boolean {
  const ip = rawIp.trim().toLowerCase().replace(/^\[|\]$/g, "")
  const zoneIdx = ip.indexOf("%")
  const clean = zoneIdx === -1 ? ip : ip.slice(0, zoneIdx)

  const family = isIP(clean)
  if (family === 4) return isPrivateOrReservedIpv4(clean)
  if (family === 6) {
    if (clean === "::" || clean === "::1") return true
    // IPv4-mapped IPv6 ::ffff:a.b.c.d or hex ::ffff:7f00:1
    if (clean.startsWith("::ffff:")) {
      const rest = clean.slice("::ffff:".length)
      if (isIP(rest) === 4) return isPrivateOrReservedIpv4(rest)
      const hexParts = rest.split(":")
      if (hexParts.length === 2) {
        const hi = Number.parseInt(hexParts[0]!, 16)
        const lo = Number.parseInt(hexParts[1]!, 16)
        if (!Number.isNaN(hi) && !Number.isNaN(lo)) {
          const v4 = `${(hi >>> 8) & 0xff}.${hi & 0xff}.${(lo >>> 8) & 0xff}.${lo & 0xff}`
          return isPrivateOrReservedIpv4(v4)
        }
      }
      return true
    }
    // Expand first hextet for prefix checks
    const first = clean.split(":")[0] || "0"
    const firstNum = Number.parseInt(first, 16)
    if (Number.isNaN(firstNum)) return true
    // fc00::/7 (Unique Local Addresses)
    if ((firstNum & 0xfe00) === 0xfc00) return true
    // fe80::/10 (Link-Local)
    if ((firstNum & 0xffc0) === 0xfe80) return true
    // ff00::/8 (Multicast)
    if ((firstNum & 0xff00) === 0xff00) return true
    // 100::/64 (discard), 2001:db8::/32 (documentation)
    if (firstNum === 0x0100) return true
    if (clean.startsWith("2001:db8:") || clean.startsWith("2001:0db8:")) return true
    return false
  }
  // Unparseable IP: fail closed.
  return true
}

const BLOCKED_HOST_SUFFIXES = [".local", ".internal", ".localhost", ".localdomain"]

/**
 * Lexical URL validation + DNS resolution anti-SSRF guard.
 */
export async function assertSafeUrl(
  rawUrl: string,
  opts: { allowHttp?: boolean; dnsLookup?: DnsLookupFn } = {},
): Promise<URL> {
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

  // Literal IP check (covers IPv4, IPv6, decimal/octal/hex forms normalized by WHATWG URL)
  if (isIP(hostname) !== 0) {
    if (isPrivateOrReservedIp(hostname)) {
      throw new SafeHttpCollectorError(
        "ssrf_blocked",
        `IP address '${hostname}' is in a private, loopback, link-local, or reserved range.`,
      )
    }
    return url
  }

  // Resolve DNS and validate every address
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

  return url
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
 * Create a guarded read-only `fetch` implementation enforcing:
 * - GET-only method
 * - Lexical + DNS anti-SSRF checks (blocking private/loopback/link-local/metadata IPs)
 * - `redirect: "error"`
 * - Timeout via `AbortSignal.timeout`
 * - Streaming response size ceiling (default 1 MiB)
 * - JSON `content-type` validation on 2xx responses
 */
export function createSafeCollectorFetch(
  opts: SafeHttpCollectorOptions = {},
): typeof globalThis.fetch {
  const maxResponseBytes = opts.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const underlyingFetch = opts.fetch ?? globalThis.fetch

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

    await assertSafeUrl(rawUrl, { allowHttp: opts.allowHttp, dnsLookup: opts.dnsLookup })

    const timeoutSignal = AbortSignal.timeout(timeoutMs)
    const combinedSignal = init?.signal
      ? AbortSignal.any([init.signal, timeoutSignal])
      : timeoutSignal

    const response = await underlyingFetch(rawUrl, {
      ...init,
      method: "GET",
      body: undefined,
      redirect: "error",
      signal: combinedSignal,
    })

    // Guard against manual redirects returned by custom fetch mocks
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => {})
      throw new SafeHttpCollectorError(
        "redirect_blocked",
        `HTTP redirect (${response.status}) refused by safeHttpCollector.`,
      )
    }

    const bytes = await readBoundedBytes(response, maxResponseBytes)

    if (response.status >= 200 && response.status < 300) {
      const ct = response.headers.get("content-type") ?? ""
      if (!isJsonContentType(ct)) {
        throw new SafeHttpCollectorError(
          "invalid_content_type",
          `Expected JSON content-type from safeHttpCollector, received '${ct || "(none)"}'.`,
        )
      }
    }

    return new Response(Buffer.from(bytes), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
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
 * the single guarded read-only HTTP path (`createSafeCollectorFetch`), composes
 * the single authentication header from `auth.state.env[0]` + `metadata.metricSource.auth`,
 * and scrubs all secrets from any thrown error.
 */
export function safeHttpCollector(
  driver: DriverHandle,
  opts: SafeHttpCollectorOptions = {},
): DriverHandle {
  const safeFetch = createSafeCollectorFetch(opts)
  const authSpec = readDriverAuthSpec(driver)

  // Validate baseUrl lexically early if present in metadata.http (fail fast at call time)
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
          const scrubbed = redactSecrets(err.message, allSecrets)
          if (scrubbed !== err.message) {
            err.message = scrubbed
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

/**
 * Public-DNS visibility + pinned probe transport for tunnel health checks.
 *
 * A freshly created Cloudflare tunnel hostname is served by the edge before
 * the authoritative zone's record is visible everywhere. The first NXDOMAIN
 * from the host's system resolver then sticks for the zone SOA negative TTL
 * (1800 s in the zone that bit us), so every later probe on that LAN keeps
 * failing on a tunnel that is actually fine, and the user's own browser
 * cannot open the URL either.
 *
 * So probes never ask the system resolver first. They ask DNS-over-HTTPS
 * (Cloudflare, falling back to Google), and once an A/AAAA answer exists they
 * connect to that address with the original hostname kept for TLS SNI and the
 * Host header. The system resolver is only a last resort, after public DNS
 * has confirmed the record.
 */

import { lookup } from "node:dns/promises"
import { request } from "node:https"

import type { FetchLike } from "./cloudflare-api.js"

/** The reason surfaced while a new hostname is not visible publicly yet. */
export const DNS_NOT_VISIBLE = "dns not yet visible on public resolvers"

export type DohResult =
  | { kind: "answer"; addresses: string[] }
  | { kind: "no-answer" }
  | { kind: "unreachable"; error: string }

export const DEFAULT_DOH_ENDPOINTS = [
  "https://cloudflare-dns.com/dns-query",
  "https://dns.google/resolve",
]

export interface DohResolverOptions {
  /** HTTP client for DoH queries. Defaults to the global fetch. */
  fetch?: FetchLike
  /** Endpoint list, in priority order (tests). */
  endpoints?: string[]
  /** Per-query timeout. Default 3000 ms. */
  timeoutMs?: number
}

interface DohJson {
  Status?: number
  Answer?: Array<{ type?: number; data?: string }>
}

/**
 * Resolve a hostname's public A/AAAA records over DNS-over-HTTPS.
 *
 * `no-answer` means at least one resolver answered authoritatively without a
 * usable record (NXDOMAIN or an empty answer). `unreachable` means no
 * resolver answered at all, which is the only case where callers may fall
 * back to the system resolver.
 */
export async function resolveViaDoh(
  hostname: string,
  opts: DohResolverOptions = {},
): Promise<DohResult> {
  const fetchImpl = opts.fetch ?? (globalThis.fetch as unknown as FetchLike)
  const endpoints = opts.endpoints ?? DEFAULT_DOH_ENDPOINTS
  const timeoutMs = opts.timeoutMs ?? 3_000
  let sawResponse = false
  let lastError = ""

  for (const type of ["A", "AAAA"] as const) {
    for (const endpoint of endpoints) {
      const url = `${endpoint}?name=${encodeURIComponent(hostname)}&type=${type}`
      try {
        const res = await fetchImpl(url, {
          method: "GET",
          headers: { accept: "application/dns-json" },
          signal: AbortSignal.timeout(timeoutMs),
        })
        if (!res.ok) {
          lastError = `HTTP ${res.status}`
          continue
        }
        const body = (await res.json()) as DohJson
        const status = body.Status ?? 0
        if (status !== 0 && status !== 3) {
          lastError = `DoH status ${status}`
          continue
        }
        sawResponse = true
        const addresses = (body.Answer ?? [])
          .filter(a => (a.type === 1 || a.type === 28) && typeof a.data === "string" && a.data.length > 0)
          .map(a => a.data as string)
        if (addresses.length > 0) return { kind: "answer", addresses }
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err)
      }
    }
  }

  return sawResponse
    ? { kind: "no-answer" }
    : { kind: "unreachable", error: lastError || "no DoH endpoint answered" }
}

export interface WaitForPublicDnsOptions {
  resolve: (hostname: string) => Promise<DohResult>
  /** Total budget before giving up. Default 60_000 ms. */
  timeoutMs?: number
  /** First retry delay. Default 500 ms. */
  initialDelayMs?: number
  /** Delay cap. Default 5000 ms. */
  maxDelayMs?: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

/**
 * Poll `resolve` with bounded exponential backoff until it returns an answer
 * or the total budget expires. The last result is returned either way, so a
 * `no-answer` timeout is a normal outcome, not an error.
 */
export async function waitForPublicDns(
  hostname: string,
  opts: WaitForPublicDnsOptions,
): Promise<DohResult> {
  const timeoutMs = opts.timeoutMs ?? 60_000
  const initialDelayMs = opts.initialDelayMs ?? 500
  const maxDelayMs = opts.maxDelayMs ?? 5_000
  const sleep = opts.sleep ?? defaultSleep
  const now = opts.now ?? Date.now
  const startedAt = now()
  let delay = initialDelayMs
  let last: DohResult = { kind: "unreachable", error: "not attempted" }

  for (;;) {
    try {
      last = await opts.resolve(hostname)
    } catch (err) {
      last = { kind: "unreachable", error: err instanceof Error ? err.message : String(err) }
    }
    if (last.kind === "answer") return last

    const remaining = timeoutMs - (now() - startedAt)
    if (remaining <= 0) return last
    await sleep(Math.min(delay, remaining))
    delay = Math.min(maxDelayMs, Math.round(delay * 1.6))
  }
}

/** System resolver, used only when DoH itself is unreachable. */
export async function systemLookup(hostname: string): Promise<string[]> {
  const found = await lookup(hostname, { all: true, verbatim: true })
  return found.map(f => f.address)
}

/**
 * A fetch that connects to a pre-resolved address while keeping the original
 * hostname for TLS SNI, certificate verification and the Host header.
 */
export function pinnedHttpsFetch(hostname: string, address: string): FetchLike {
  return (input, init) => {
    const url = new URL(input)
    return new Promise((resolve, reject) => {
      const req = request(
        {
          host: address,
          port: url.port ? Number(url.port) : 443,
          path: `${url.pathname}${url.search}`,
          method: init?.method ?? "GET",
          servername: hostname,
          headers: { ...(init?.headers ?? {}), Host: url.host },
          rejectUnauthorized: true,
          ...(init?.signal ? { signal: init.signal } : {}),
        },
        res => {
          const chunks: Buffer[] = []
          res.on("data", (chunk: Buffer) => chunks.push(chunk))
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8")
            const status = res.statusCode ?? 0
            resolve({
              status,
              ok: status >= 200 && status < 300,
              headers: {
                get(name: string): string | null {
                  const value = res.headers[name.toLowerCase()]
                  return Array.isArray(value) ? value.join(",") : (value ?? null)
                },
              },
              json: async () => JSON.parse(text) as unknown,
              text: async () => text,
            })
          })
        },
      )
      req.on("error", reject)
      req.end()
    })
  }
}

/** The production wiring: DoH visibility, pinned HTTPS, system fallback. */
export interface PublicDns {
  resolve(hostname: string): Promise<DohResult>
  pinnedFetch(hostname: string, address: string): FetchLike
  systemLookup(hostname: string): Promise<string[]>
}

export function defaultPublicDns(opts: DohResolverOptions = {}): PublicDns {
  return {
    resolve: hostname => resolveViaDoh(hostname, opts),
    pinnedFetch: (hostname, address) => pinnedHttpsFetch(hostname, address),
    systemLookup,
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise<void>(resolve => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

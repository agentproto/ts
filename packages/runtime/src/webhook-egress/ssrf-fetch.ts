/**
 * SSRF-guarded outbound HTTPS POST for webhook egress (W-A of
 * `.plans/sentinel-mcp-events/PLAN.md`).
 *
 * Frozen failure-mode reasons: `non_https | private_target | redirect |
 * timeout | connect` — mapped by challenge to the §3 ChallengeFailureReason
 * table; the SAME function guards BOTH the challenge and delivery path (I3).
 * No HTTP client library addition: node http/https only.
 *
 * Safety model (one predicate, fail closed):
 *   1. scheme must be https → `non_https`
 *   2. ALL DNS-resolved addresses (A + AAAA, plus literal-IP hosts) must pass
 *      {@link isPubliclyRoutable}, else `private_target` — one rejected
 *      address fails; unparseable/odd literals fail closed
 *   3. connect pins the VALIDATED IP (no second resolution → the
 *      DNS-rebinding TOCTOU is closed) while `servername` keeps the ORIGINAL
 *      hostname for TLS SNI + certificate verification
 *   4. redirects are never followed: a 3xx comes back as a plain
 *      `{status: 3xx}` result (challenge → "non_2xx", delivery → retryable);
 *      a non-https redirect target additionally throws `redirect`
 *   5. hard `timeoutMs` budget; request body clamped to 256 KiB here too
 *      (defense-in-depth — delivery clamps before signing)
 */

import { lookup } from "node:dns/promises"
import { request } from "node:https"

export type SsrfFetchReason = "non_https" | "private_target" | "redirect" | "timeout" | "connect"

export class SsrfFetchError extends Error {
  constructor(public readonly reason: SsrfFetchReason, message: string) {
    super(message)
    this.name = "SsrfFetchError"
  }
}

export interface SsrfFetchInit {
  method?: "POST"
  headers?: Record<string, string>
  /** ≤ 262 144; enforced also on response read (only status + body read). */
  body?: Uint8Array
  timeoutMs: number // default 10_000 on challenge, 15_000 on delivery
}

export interface SsrfFetchResult {
  status: number
  body: string // clamped to 4 KiB for diagnostics
}

export const MAX_REQUEST_BODY_BYTES = 262_144 // 256 KiB
const MAX_RESPONSE_DIAGNOSTIC_BYTES = 4_096

/**
 * The one predicate for every address this module may connect to. Fails
 * closed — anything unparseable, IPv4-mapped with an invalid embedded v4, or
 * inside a non-globally-routable block is NOT public.
 *
 * Plan §4 W-A.2 ranges:
 *   IPv4 — 0/8, 10/8, 127/8, 169.254/16, 172.16/12, 192.0.0.0/24,
 *          192.0.2.0/24, 198.18/15, 198.51.100.0/24, 203.0.113.0/24,
 *          100.64/10 (CGNAT), 224/4 (multicast), 240/4 (reserved)
 *   IPv6 — ::, ::1, fc00::/7 (ULA), fe80::/10 (link-local),
 *          ff00::/8 (multicast), 2001:db8::/32 (doc range), and ::ffff:
 *          mapped-v4 whose EMBEDDED v4 re-runs this very predicate
 */
export function isPubliclyRoutable(ipRaw: string): boolean {
  const ip = ipRaw.includes("%") ? ipRaw.slice(0, ipRaw.indexOf("%")) : ipRaw
  const v4 = parseIpv4(ip)
  if (v4) return ipv4Public(v4[0], v4[1], v4[2], v4[3])
  const v6 = parseIpv6Bytes(ip)
  if (v6) return ipv6Public(v6)
  return false
}

function ipv4Public(a: number, b: number, c: number, d: number): boolean {
  if (a === 0) return false // 0/8
  if (a === 10) return false // 10/8
  if (a === 127) return false // 127/8 loopback — also inherently blocks a callback back into our own inbound URL
  if (a === 100 && b >= 64 && b <= 127) return false // 100.64/10 CGNAT
  if (a === 169 && b === 254) return false // 169.254/16 link-local
  if (a === 172 && b >= 16 && b <= 31) return false // 172.16/12
  if (a === 192 && b === 168) return false // 192.168/16 RFC1918
  if (a === 192 && b === 0 && c === 0) return false // 192.0.0.0/24 infrastructure
  if (a === 192 && b === 0 && c === 2) return false // 192.0.2.0/24 doc
  if (a === 198 && b === 51 && c === 100) return false // 198.51.100.0/24 doc
  if (a === 198 && (b === 18 || b === 19)) return false // 198.18/15 benchmark
  if (a === 203 && b === 0 && c === 113) return false // 203.0.113.0/24 doc
  if (a >= 224) return false // 224/4 multicast + 240/4 reserved
  return true
}

interface V6 {
  bytes: Uint8Array
  /** Non-null → IPv4-mapped; the embedded v4 octets. */
  mapped?: [number, number, number, number]
}

function ipv6Public(v6: V6): boolean {
  if (v6.mapped) return ipv4Public(v6.mapped[0], v6.mapped[1], v6.mapped[2], v6.mapped[3])
  const b = v6.bytes
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const b0 = v.getUint8(0)
  const b1 = v.getUint8(1)
  const b2 = v.getUint8(2)
  const b3 = v.getUint8(3)
  const b15 = v.getUint8(15)
  const tailZero = b.slice(1, 15).every((x) => x === 0)
  if (b.every((x) => x === 0)) return false // ::
  if (tailZero && b0 === 0 && b15 === 1) return false // ::1
  if ((b0 & 0xfe) === 0xfc) return false // fc00::/7 ULA
  if (b0 === 0xfe && (b1 & 0xc0) === 0x80) return false // fe80::/10 link-local
  if (b0 === 0xff) return false // ff00::/8 multicast
  if (b0 === 0x20 && b1 === 0x01 && b2 === 0x0d && b3 === 0xb8) return false // 2001:db8::/32 doc
  return true
}

// ── Literal parsing ─────────────────────────────────────────────────

function parseIpv4(ip: string): [number, number, number, number] | null {
  const parts = ip.split(".")
  if (parts.length !== 4) return null
  const o: number[] = []
  for (const part of parts) {
    // Strict dotted-quad: no leading zeros (blocks the 0x/decimal-literal traps).
    if (!/^(?:0|[1-9]\d{0,2})$/.test(part)) return null
      const n = Number(part)
      if (n > 255) return null
      o.push(n)
    }
    const first = o[0]
    const second = o[1]
    const third = o[2]
    const fourth = o[3]
    if (first === undefined || second === undefined || third === undefined || fourth === undefined) return null
    return [first, second, third, fourth]
  }

/**
 * Parse an IPv6 literal to 16 bytes; `null` when not an IPv6 literal
 * (fail closed — unparseable = blocked). Supports `::` compression and an
 * optional dotted-quad IPv4 tail (`::ffff:1.2.3.4`).
 */
function parseIpv6Bytes(rawIp: string): V6 | null {
  const ip = rawIp.replace(/^\[|\]$/g, "")
  if (!ip.includes(":")) return null
  if (ip.lastIndexOf("::") !== ip.indexOf("::")) return null // more than one "::"
  // Dotted-quad IPv4 group (`::ffff:1.2.3.4`, `1:2:3:4:5:6:1.2.3.4`): must be
  // preceded by ":" — anything else (e.g. "ffff1.2.3.4") fails closed below.
  const v4Match = ip.match(/^(?:.*:)(\d{1,3}(?:\.\d{1,3}){3})$/)
  const compressed = ip.includes("::")
  if (compressed) {
    const halves = ip.split("::")
    const before = halves[0] ?? ""
    const after = halves[1] ?? ""
    const head = before === "" ? [] : before.split(":")
    if (head.some((g) => !isHexGroup(g))) return null
    const tail = after === "" ? [] : after.replace(/(\d{1,3}(?:\.\d{1,3}){3})$/, "").split(":").filter((g) => g !== "")
    if (tail.some((g) => !isHexGroup(g))) return null
    return fromGroups(head, tail, v4Match?.[1])
  }
  // Uncompressed: exactly 8 groups; the last may be a dotted-quad v4 (then 6 hex groups).
  const all = ip.split(":")
  const v4 = v4Match ? [all[all.length - 1]] : []
  const hexGroups = all.slice(0, all.length - (v4Match ? 1 : 0))
  if (all.length !== (v4Match ? 6 : 8) + (v4Match ? 1 : 0)) return null
  if (hexGroups.some((g) => !isHexGroup(g))) return null
  return fromGroups(hexGroups, [], v4 ? v4[0] : undefined)
}

function isHexGroup(g: string): boolean {
  return /^[\da-fA-F]{1,4}$/.test(g)
}

/** Head groups write ahead; tail groups are end-aligned; v4 tail = last 4 bytes. */
function fromGroups(head: string[], tail: string[], v4?: string): V6 | null {
  if (head.length + tail.length > (v4 ? 6 : 8)) return null
  const bytes = new Uint8Array(16)
  const writeGroup = (g: string | undefined, offset: number): boolean => {
    if (g === undefined) return false
    const v = parseInt(g, 16)
    bytes[offset] = v >> 8
    bytes[offset + 1] = v & 0xff
    return true
  }
  head.forEach((g, i) => writeGroup(g, i * 2))
  const tailStart = 16 - tail.length * 2 - (v4 ? 4 : 0)
  tail.forEach((g, i) => writeGroup(g, tailStart + i * 2))
  if (v4) {
    const o = parseIpv4(v4)
    if (!o) return null
    // The v4 tail always lands at bytes[12..15] in these expansions.
    bytes[12] = o[0]
    bytes[13] = o[1]
    bytes[14] = o[2]
    bytes[15] = o[3]
    const mapped = bytes.slice(0, 10).every((x) => x === 0) && bytes[10] === 0xff && bytes[11] === 0xff
    return { bytes, mapped: mapped ? o : undefined }
  }
  return { bytes }
}

// ── DNS resolution (overridable in tests only) ─────────────────────

export type SsrfResolvers = {
  /** Replaces both A and AAAA resolution. Returns every address, any family. */
  lookup?: (host: string) => Promise<Array<{ address: string; family: 4 | 6 }>>
}

async function resolveHost(hostname: string, resolvers: Partial<SsrfResolvers>): Promise<string[]> {
  // Literal IPs skip DNS entirely — validated directly by the predicate.
  if (parseIpv4(hostname)) return [hostname]
  const bracketless = hostname.replace(/^\[|\]$/g, "")
  if (bracketless.includes(":")) return [bracketless]
  if (resolvers.lookup) return (await resolvers.lookup(bracketless)).map((r) => r.address)
  const found = await lookup(bracketless, { all: true, verbatim: true })
  return found.map((f) => f.address)
}

// ── Test-only dispatcher seam ──────────────────────────────────────
// The suites mock the HTTP boundary by replacing the dispatcher; everything
// upstream (URL parse, scheme gate, DNS policy, private filter) still runs —
// the modules under test are never mocked around, only what they would send.

export type EgressDispatcher = (req: {
  url: string
  headers: Record<string, string>
  body?: Uint8Array
  timeoutMs: number
}) => Promise<SsrfFetchResult>

let testDispatcher: EgressDispatcher | null = null

/** vitest-only: set a recording dispatcher; pass `null` to restore. */
export function setEgressDispatcherForTests(dispatcher: EgressDispatcher | null): void {
  testDispatcher = dispatcher
}

// ── The one gate (I3: challenge AND delivery call this identical fn) ─

export async function ssrfFetch(
  url: string,
  init: SsrfFetchInit,
  io: { resolvers?: SsrfResolvers } = {},
): Promise<SsrfFetchResult> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new SsrfFetchError("non_https", "unparseable callback URL")
  }
  if (parsed.protocol !== "https:") {
    throw new SsrfFetchError("non_https", `scheme ${parsed.protocol} — https only`)
  }
  if ((init.body?.byteLength ?? 0) > MAX_REQUEST_BODY_BYTES) {
    throw new SsrfFetchError("connect", `request body exceeds the ${MAX_REQUEST_BODY_BYTES}-byte clamp`)
  }

  if (testDispatcher) {
    // Test seam: the dispatcher replaces the WIRE only. Literal-IP hosts still
    // pass the predicate; named hosts need no DNS policy in tests (the suites
    // that exercise the policy call the real path with injected resolvers).
    const literal = parseIpv4(parsed.hostname)
    if (literal && !ipv4Public(literal[0], literal[1], literal[2], literal[3])) {
      throw new SsrfFetchError("private_target", `literal non-public address ${parsed.hostname}`)
    }
    return await testDispatcher({ url, headers: init.headers ?? {}, body: init.body, timeoutMs: init.timeoutMs })
  }

  const candidates = await resolveHost(parsed.hostname, io.resolvers ?? {})
  if (candidates.length === 0) {
    throw new SsrfFetchError("connect", `no addresses resolved for ${parsed.hostname}`)
  }
  const rejected = candidates.find((ip) => !isPubliclyRoutable(ip))
  if (rejected !== undefined) {
    throw new SsrfFetchError("private_target", `${parsed.hostname} resolves to non-public address ${rejected}`)
  }
  const connectIp = candidates[0] ?? candidates[candidates.length - 1]
  if (connectIp === undefined) throw new SsrfFetchError("connect", "no address available for connect")

  const port = parsed.port ? Number(parsed.port) : 443
  return await rawPost({
    connectIp,
    servername: parsed.hostname,
    port,
    path: `${parsed.pathname}${parsed.search}`,
    headers: init.headers ?? {},
    body: init.body,
    timeoutMs: init.timeoutMs,
  })
}

interface RawPostArgs {
  connectIp: string
  servername: string
  port: number
  path: string
  headers: Record<string, string>
  body?: Uint8Array
  timeoutMs: number
}

function rawPost(args: RawPostArgs): Promise<SsrfFetchResult> {
  return new Promise<SsrfFetchResult>((resolve, reject) => {
    const req = request({
      // Connect to the PRE-VALIDATED address; keep the original hostname in
      // `servername` so SNI and the certificate check never loosen.
      host: args.connectIp,
      port: args.port,
      path: args.path,
      method: "POST",
      servername: args.servername,
      headers: args.headers,
      rejectUnauthorized: true,
    })
    let settled = false
    const fail = (reason: SsrfFetchReason, message: string): void => {
      if (settled) return
      settled = true
      req.destroy()
      reject(new SsrfFetchError(reason, message))
    }
    const ok = (status: number, body: string): void => {
      if (settled) return
      settled = true
      resolve({ status, body })
    }

    req.setTimeout(args.timeoutMs, () => fail("timeout", `no response within ${args.timeoutMs}ms`))
    req.on("error", (err: NodeJS.ErrnoException) => {
      fail("connect", err.message)
    })

    req.on("response", (res) => {
      const status = res.statusCode ?? 0
      let diags = Buffer.alloc(0)
      res.on("data", (chunk: Buffer) => {
        if (diags.length < MAX_RESPONSE_DIAGNOSTIC_BYTES) {
          diags = Buffer.concat([diags, chunk.subarray(0, MAX_RESPONSE_DIAGNOSTIC_BYTES - diags.length)])
        }
        if (diags.length >= MAX_RESPONSE_DIAGNOSTIC_BYTES) res.destroy()
      })
      res.on("end", () => {
        if (status >= 300 && status < 400) {
          const location = res.headers["location"]
          if (typeof location === "string" && !new URL(location, `https://${args.servername}`).protocol.startsWith("https")) {
            fail("redirect", `redirect target ${location} is not https — never chased`)
            return
          }
          // Legit redirect: returned as data, NOT followed.
        }
        ok(status, diags.toString("utf8"))
      })
      res.on("error", (err: NodeJS.ErrnoException) => {
        fail("connect", err.message)
      })
    })

    if (args.body) req.write(Buffer.from(args.body))
    req.end()
  })
}

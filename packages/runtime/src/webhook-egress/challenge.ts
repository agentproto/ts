/**
 * Callback challenge verification (W-A of `.plans/sentinel-mcp-events/PLAN.md`,
 * §3 frozen): POST `{"type":"verification","challenge":"<fresh 64-hex>"}` to
 * the candidate callback URL, signed with the CANDIDATE secret, carrying
 * `X-MCP-Subscription-Id`; require 2xx and a constant-time-equal
 * `{"challenge":"<same>"}` echo in the response body.
 *
 * Success cache: keyed (principal, normalized callback URL, sha256(secret)),
 * bounded TTL 10 min. A NEW secret during rotation NEVER resolves a cache
 * hit — the sha256(secret) key component structurally forces
 * re-verification (the cache can never bless an unverified secret).
 *
 * The outbound POST runs through the SAME `ssrfFetch` gate as delivery (I3) —
 * injectable here only for tests; production passes nothing.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { signWebhook, decodeWhsecSecret } from "./signing.js"
import { ssrfFetch, SsrfFetchError, type SsrfFetchReason } from "./ssrf-fetch.js"

export type ChallengeOutcome =
  | { ok: true; verificationBytes: Uint8Array }
  | { ok: false; reason: ChallengeFailureReason; detail: string }

export type ChallengeFailureReason =
  | "challenge_failed"
  | "timeout"
  | "non_https"
  | "ssrf_blocked"
  | "non_2xx"

export interface VerifyCallbackInput {
  principal: string
  url: string
  subscriptionId: string
  secret: string
}

export interface VerifyCallbackDeps {
  /** Replaces the POST boundary. Default: the shared `ssrfFetch` gate. */
  fetch?: (url: string, init: SsrfFetchArgs) => Promise<SsrfFetchView>
  /** Clock for the bounded TTL. Default: real wall clock. */
  now?: () => number
}

export interface SsrfFetchArgs {
  method?: "POST"
  headers?: Record<string, string>
  body?: Uint8Array
  timeoutMs: number
}

export interface SsrfFetchView {
  status: number
  body: string
}

/** §4 W-A task 4: the challenge reason table (single mapped, none unmapped). */
export function challengeReasonForSsrf(reason: SsrfFetchReason): ChallengeFailureReason {
  if (reason === "non_https") return "non_https"
  if (reason === "private_target" || reason === "redirect") return "ssrf_blocked"
  return "timeout" // "timeout" and "connect" (detail preserved on the outcome)
}

const CHALLENGE_TTL_MS = 10 * 60 * 1000
const encoder = new TextEncoder()

interface CacheEntry {
  /** Exact request bytes the last verified challenge used (kept so the
   *  cached outcome is itself stable and I2-safe). */
  requestBytes: Uint8Array
  expiresAt: number
}

const cache = new Map<string, CacheEntry>()
const cacheHits = { hits: 0, missed: 0 }

export function challengeCacheSize(): number {
  return cache.size
}

export function challengeCacheHits(): { hits: number; missed: number } {
  return { hits: cacheHits.hits, missed: cacheHits.missed }
}

/** vitest-only: clear the success cache between suites. */
export function resetChallengeCacheForTests(): void {
  cache.clear()
  cacheHits.hits = 0
  cacheHits.missed = 0
}

/** Cache-key URL normalization (never reused for anything else). */
export function normalizeCallbackUrl(url: string): string | null {
  try {
    const u = new URL(url)
    const port = u.port === "443" ? "" : `:${u.port}`
    return `${u.protocol.toLowerCase()}//${u.hostname.toLowerCase()}${port}${u.pathname}${u.search}`
  } catch {
    return null
  }
}

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex")
}

/** Constant-time equality that tolerates different lengths. */
function constantTimeEq(a: string, b: string): boolean {
  const da = createHash("sha256").update(a, "utf8").digest()
  const db = createHash("sha256").update(b, "utf8").digest()
  return timingSafeEqual(da, db)
}

export async function verifyCallback(input: VerifyCallbackInput, deps: VerifyCallbackDeps = {}): Promise<ChallengeOutcome> {
  const now = deps.now ?? (() => Date.now())

  const normalized = normalizeCallbackUrl(input.url)
  if (normalized === null || !normalized.startsWith("https://")) {
    return { ok: false, reason: "non_https", detail: "callback URL must be an https URL" }
  }
  if (decodeWhsecSecret(input.secret) === null) {
    return {
      ok: false,
      reason: "challenge_failed",
      detail: "invalid secret format — must be whsec_ + base64 decoding to 24..64 bytes (the caller validates before this; a bad secret is never cached)",
    }
  }

  const cacheKey = `${input.principal}|${normalized}|${hashSecret(input.secret)}`
  const cached = cache.get(cacheKey)
  if (cached && cached.expiresAt > now()) {
    cacheHits.hits += 1
    return { ok: true, verificationBytes: cached.requestBytes }
  }
  if (cached) cache.delete(cacheKey)
  cacheHits.missed += 1

  const challenge = randomBytes(32).toString("hex") // fresh 64-hex
  const requestBytes = encoder.encode(JSON.stringify({ type: "verification", challenge }))
  const msgId = `msg_verification_${randomBytes(12).toString("hex")}`
  const timestamp = Math.floor(now() / 1000)
  let headers: Record<string, string>
  try {
    const signed = signWebhook({ msgId, timestamp, payload: requestBytes, secrets: [input.secret] })
    headers = {
      ...signed,
      "content-type": "application/json",
      "X-MCP-Subscription-Id": input.subscriptionId,
    }
  } catch (err) {
    return { ok: false, reason: "challenge_failed", detail: `signing failed: ${(err as Error).message}` }
  }

  let response: SsrfFetchView
  try {
    response = await (deps.fetch ?? ssrfFetch)(input.url, {
      method: "POST",
      headers,
      body: requestBytes,
      timeoutMs: 10_000, // default challenge timeout (delivery uses 15_000)
    })
  } catch (err) {
    if (err instanceof SsrfFetchError) {
      return { ok: false, reason: challengeReasonForSsrf(err.reason), detail: `${err.reason}: ${err.message}` }
    }
    return { ok: false, reason: "timeout", detail: (err as Error).message }
  }

  if (response.status < 200 || response.status > 299) {
    return { ok: false, reason: "non_2xx", detail: `callback responded with status ${response.status}` }
  }
  let parsedBody: unknown
  try {
    parsedBody = JSON.parse(response.body)
  } catch {
    return { ok: false, reason: "challenge_failed", detail: "response body is not JSON" }
  }
  const echoed = (parsedBody as { challenge?: unknown })?.challenge
  if (typeof echoed !== "string" || !constantTimeEq(echoed, challenge)) {
    return { ok: false, reason: "challenge_failed", detail: "response did not echo the fresh challenge" }
  }
  cache.set(cacheKey, { requestBytes, expiresAt: now() + CHALLENGE_TTL_MS })
  return { ok: true, verificationBytes: requestBytes }
}

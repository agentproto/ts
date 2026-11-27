/**
 * Stripe webhook signatures, with `node:crypto` only (no SDK).
 *
 * The `Stripe-Signature` header is a list of `key=value` pairs: one `t` (the
 * timestamp, in seconds) and one or more `v1` (hex HMAC-SHA256 of
 * `${t}.${body}` keyed by the endpoint secret). Several `v1` appear while a
 * secret is rolled: any one that matches is enough. Other schemes (`v0`, ...)
 * are ignored.
 */
import { createHmac, timingSafeEqual } from "node:crypto"

/** Default tolerance between the signed timestamp and now, in seconds. */
export const DEFAULT_TOLERANCE_SEC = 300

export class StripeSignatureError extends Error {
  override name = "StripeSignatureError"
}

/** The header value, whatever the case of its name. */
export function signatureHeader(headers: Record<string, string | string[] | undefined>): string | null {
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== "stripe-signature") continue
    const value = Array.isArray(v) ? v[0] : v
    return typeof value === "string" && value !== "" ? value : null
  }
  return null
}

const hmac = (secret: string, payload: string): string => createHmac("sha256", secret).update(payload, "utf8").digest("hex")

/**
 * Throws `StripeSignatureError` unless one `v1` of the header signs
 * `${t}.${body}` with `secret` and `t` is within `toleranceSec` of `nowMs`.
 * The error message never carries the secret nor the expected signature.
 */
export function verifyStripeSignature(body: string, header: string | null, secret: string, nowMs: number, toleranceSec = DEFAULT_TOLERANCE_SEC): void {
  if (!secret) throw new StripeSignatureError("stripe webhook: no signing secret is configured")
  if (!header) throw new StripeSignatureError("stripe webhook: no Stripe-Signature header")
  let t: number | null = null
  const v1: string[] = []
  for (const part of header.split(",")) {
    const i = part.indexOf("=")
    if (i <= 0) continue
    const key = part.slice(0, i).trim()
    const value = part.slice(i + 1).trim()
    if (key === "t") t = /^\d+$/.test(value) ? Number(value) : Number.NaN
    else if (key === "v1") v1.push(value)
  }
  if (t === null || !Number.isFinite(t)) throw new StripeSignatureError("stripe webhook: the signature header has no valid timestamp")
  if (v1.length === 0) throw new StripeSignatureError("stripe webhook: the signature header has no v1 signature")
  const expected = Buffer.from(hmac(secret, `${t}.${body}`), "utf8")
  const match = v1.some(sig => {
    const given = Buffer.from(sig, "utf8")
    return given.length === expected.length && timingSafeEqual(given, expected)
  })
  if (!match) throw new StripeSignatureError("stripe webhook: no signature matches the body")
  const ageSec = Math.abs(nowMs / 1000 - t)
  if (ageSec > toleranceSec) throw new StripeSignatureError(`stripe webhook: the signed timestamp is ${Math.round(ageSec)}s away from now (tolerance ${toleranceSec}s)`)
}

/**
 * A `Stripe-Signature` header for `body`, as Stripe builds it. For tests and
 * local replays: sign with a secret made for the test, never a real one.
 */
export function stripeSignatureHeader(body: string, secret: string, timestampSec: number): string {
  return `t=${timestampSec},v1=${hmac(secret, `${timestampSec}.${body}`)}`
}

/**
 * Standard Webhooks signing helpers for the MCP Events subscriber side.
 *
 * The daemon signs `${webhook-id}.${webhook-timestamp}.${rawBody}` with
 * HMAC-SHA256 keyed by the base64 payload of the `whsec_` secret the
 * subscriber supplied at `events/subscribe`. Verification must run on the
 * raw body bytes, never on a re-serialised object.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"

/** Seconds a delivery's timestamp may differ from now before it is rejected. */
export const TIMESTAMP_TOLERANCE_S = 300

const SECRET_PREFIX = "whsec_"

/** A fresh subscriber secret: `whsec_` + 32 random bytes, base64. */
export function generateSecret(): string {
  return SECRET_PREFIX + randomBytes(32).toString("base64")
}

/** The HMAC key behind a `whsec_` secret, or `null` when it is malformed (24..64 decoded bytes). */
export function decodeSecret(secret: string): Buffer | null {
  if (!secret.startsWith(SECRET_PREFIX)) return null
  const key = Buffer.from(secret.slice(SECRET_PREFIX.length), "base64")
  return key.length >= 24 && key.length <= 64 ? key : null
}

export interface WebhookHeaders {
  id: string
  timestamp: string
  /** Space-separated `v1,<base64>` candidates, as sent in `webhook-signature`. */
  signature: string
}

/** Sign a body the way the daemon does (used by tests and local simulators). */
export function signWebhook(secret: string, id: string, timestamp: string, body: string): string {
  const key = decodeSecret(secret)
  if (!key) throw new Error("invalid whsec_ secret")
  return "v1," + createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64")
}

/** True when any signature candidate matches and the timestamp is within tolerance. */
export function verifyWebhook(
  secret: string,
  headers: WebhookHeaders,
  body: string,
  nowSeconds: number = Date.now() / 1000,
): boolean {
  const key = decodeSecret(secret)
  if (!key) return false
  const age = Math.abs(nowSeconds - Number(headers.timestamp))
  if (!(age <= TIMESTAMP_TOLERANCE_S)) return false
  const expected = Buffer.from(createHmac("sha256", key).update(`${headers.id}.${headers.timestamp}.${body}`).digest("base64"))
  return headers.signature.split(" ").some(candidate => {
    const [version, value] = candidate.split(",")
    if (version !== "v1" || !value) return false
    const got = Buffer.from(value)
    return got.length === expected.length && timingSafeEqual(got, expected)
  })
}

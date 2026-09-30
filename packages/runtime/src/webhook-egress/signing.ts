/**
 * Standard Webhooks `whsec_` signing for webhook egress (W-A of
 * `.plans/sentinel-mcp-events/PLAN.md`).
 *
 * Contract (frozen §3):
 *   - HMAC-SHA256 over `msgId.timestamp.body` (raw bytes; `.update` chained so
 *     the body is never re-encoded — payload arrives as `Uint8Array`, I2).
 *   - Signature print = standard base64 (NOT base64url): `v1,<b64>`.
 *   - HMAC key = the base64 payload DECODED after the `whsec_` prefix.
 *   - Multi-secret: space-separated `v1,<sig>` segments (rotation window).
 *   - Returns ONLY headers — the caller owns the bytes and signs them again
 *     with a fresh timestamp on retry; signing never re-serializes.
 */

import { createHmac } from "node:crypto"

export interface WebhookSignInput {
  /** Stable event id (`evt_…` / verification `msg_verification_…`) — same across retries. */
  msgId: string
  /** Seconds, Unix epoch (Standard Webhooks wire format). */
  timestamp: number
  /** Exact bytes — signed once (I2). Caller passes the serialization; signing never re-serializes. */
  payload: Uint8Array
  /** One or, during a rotation window, two secrets (`whsec_…`). */
  secrets: readonly string[]
}

export type WebhookSignatureHeaders = {
  "webhook-id": string
  "webhook-timestamp": string
  "webhook-signature": string // `v1,b64 sigA v1,b64 sigB`
}

const WHSEC_PREFIX = "whsec_"

/**
 * Encode raw secret bytes into the `whsec_<base64>` wire format.
 * Inverse of {@link decodeWhsecSecret}.
 */
export function encodeWhsecSecret(raw: Uint8Array): string {
  return WHSEC_PREFIX + Buffer.from(raw).toString("base64")
}

/**
 * Decode a `whsec_…` secret to its raw HMAC key: standard-base64 payload
 * after the prefix, which must decode to 24..64 bytes. Returns `null` on any
 * violation (bad prefix, not base64, length out of range). The canonical
 * validator for W-C: a submit failing this is `-32602` upstream; egress
 * surfaces it as a categorized challenge failure.
 */
export function decodeWhsecSecret(secret: string): Buffer | null {
  if (typeof secret !== "string" || !secret.startsWith(WHSEC_PREFIX)) return null
  const encoded = secret.slice(WHSEC_PREFIX.length)
  if (encoded.length === 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
    return null
  }
  let key: Buffer
  try {
    key = Buffer.from(encoded, "base64")
  } catch {
    return null
  }
  if (key.length < 24 || key.length > 64) return null
  return key
}

/**
 * Sign exactly the bytes given. Throws `Error` when any secret fails
 * {@link decodeWhsecSecret} (callers must have validated upstream; a bad
 * secret at this point is a programmer error, never silently signed).
 */
export function signWebhook(input: WebhookSignInput): WebhookSignatureHeaders {
  if (input.secrets.length === 0) throw new Error("signWebhook: at least one secret is required")
  const prefix = Buffer.from(`${input.msgId}.${input.timestamp}.`, "utf8")
  const payload = Buffer.from(input.payload.buffer, input.payload.byteOffset, input.payload.byteLength)
  const segments = input.secrets.map((secret) => {
    const key = decodeWhsecSecret(secret)
    if (!key) throw new Error(`signWebhook: invalid webhooks secret format: ${redactPrefix(secret)}`)
    const mac = createHmac("sha256", key).update(prefix).update(payload).digest()
    return `v1,${mac.toString("base64")}`
  })
  return {
    "webhook-id": input.msgId,
    "webhook-timestamp": String(input.timestamp),
    "webhook-signature": segments.join(" "),
  }
}

/** Never log material: show only the (non-secret) prefix shape. */
function redactPrefix(secret: string): string {
  return `${WHSEC_PREFIX}<${secret.length - WHSEC_PREFIX.length} b64 chars, invalid>`
}

/**
 * `sign-body-once` — signWebhook returns ONLY headers, signs EXACTLY the
 * bytes given (I2), never re-serializes, and the HMAC is the Standard
 * Webhooks canon: HMAC-SHA256(key, `${msgId}.${timestamp}.${body}`) with the
 * key = base64 payload DECODED after the `whsec_` prefix, printed as
 * standard base64 (`v1,<b64>`, NOT base64url).
 */

import { createHmac } from "node:crypto"
import { describe, expect, it } from "vitest"

import { signWebhook, encodeWhsecSecret, decodeWhsecSecret } from "../../webhook-egress/signing.js"

function key(): Buffer {
  // 32 raw bytes → 24h of valid whsec material (24..64B window).
  return Buffer.from("0123456789abcdef0123456789abcdef", "utf8")
}

function expectedSig(msgId: string, timestamp: number, payload: Uint8Array, rawKey: Buffer): string {
  const mac = createHmac("sha256", rawKey)
    .update(`${msgId}.${timestamp}.`, "utf8")
    .update(Buffer.from(payload))
    .digest()
  return `v1,${mac.toString("base64")}`
}

const SECRET = encodeWhsecSecret(key())

describe("sign-body-once", () => {
  it("returns exactly the three Standard Webhooks headers and nothing else", () => {
    const payload = new TextEncoder().encode(JSON.stringify({ hello: "world" }))
    const headers = signWebhook({ msgId: "evt_1", timestamp: 1_700_000_000, payload, secrets: [SECRET] })
    expect(Object.keys(headers).sort()).toEqual(["webhook-id", "webhook-signature", "webhook-timestamp"])
    expect(headers["webhook-id"]).toBe("evt_1")
    expect(headers["webhook-timestamp"]).toBe("1700000000")
  })

  it("the signature is HMAC-SHA256 over msgId.timestamp.body with the DECODED whsec key, standard base64", () => {
    const payload = new TextEncoder().encode("exact-bytes-never-re-encoded")
    const headers = signWebhook({ msgId: "evt_2", timestamp: 42, payload, secrets: [SECRET] })
    expect(headers["webhook-signature"]).toBe(expectedSig("evt_2", 42, payload, key()))
    // standard (NOT url) base64: no `-_` characters for this payload class
    expect(headers["webhook-signature"]).toMatch(/^v1,[A-Za-z0-9+/]+={0,2}$/)
  })

  it("the same body bytes produce the same signature — no re-serialization drift (I2)", () => {
    const payload = new TextEncoder().encode('{"a":1,"b":2}')
    const a = signWebhook({ msgId: "evt_3", timestamp: 7, payload, secrets: [SECRET] })
    const b = signWebhook({ msgId: "evt_3", timestamp: 7, payload, secrets: [SECRET] })
    expect(a).toEqual(b)
  })

  it("changing the payload bytes changes the signature — signing is byte-sensitive", () => {
    const a = signWebhook({ msgId: "evt_4", timestamp: 7, payload: new TextEncoder().encode("one "), secrets: [SECRET] })
    const b = signWebhook({ msgId: "evt_4", timestamp: 7, payload: new TextEncoder().encode("two "), secrets: [SECRET] })
    expect(a["webhook-signature"]).not.toBe(b["webhook-signature"])
  })

  it("decodeWhsecSecret enforces the whsec_ prefix and the 24..64 byte window", () => {
    expect(decodeWhsecSecret(SECRET)).toEqual(key())
    expect(decodeWhsecSecret("no-prefix-0123456789abcdef01234567")).toBeNull()
    // 23 bytes raw → 32 b64 chars → too SHORT
    expect(decodeWhsecSecret(encodeWhsecSecret(new Uint8Array(23)))).toBeNull()
    // 65 bytes raw → too LONG
    expect(decodeWhsecSecret(encodeWhsecSecret(new Uint8Array(65)))).toBeNull()
    // boundaries hold
    expect(decodeWhsecSecret(encodeWhsecSecret(new Uint8Array(24)))).not.toBeNull()
    expect(decodeWhsecSecret(encodeWhsecSecret(new Uint8Array(64)))).not.toBeNull()
    expect(decodeWhsecSecret("whsec_%%%%")).toBeNull() // not base64
  })

  it("throws (never silently signs) on an invalid secret", () => {
    const payload = new TextEncoder().encode("x")
    expect(() => signWebhook({ msgId: "e", timestamp: 1, payload, secrets: ["garbage"] })).toThrow()
    expect(() => signWebhook({ msgId: "e", timestamp: 1, payload, secrets: [] })).toThrow()
  })
})

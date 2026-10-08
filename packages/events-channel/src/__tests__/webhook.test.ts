import { describe, expect, it } from "vitest"
import { decodeSecret, generateSecret, signWebhook, TIMESTAMP_TOLERANCE_S, verifyWebhook } from "../webhook.js"

const secret = generateSecret()
const NOW = 1_800_000_000
const headersFor = (body: string, ts = NOW, id = "evt_1") => ({ id, timestamp: String(ts), signature: signWebhook(secret, id, String(ts), body) })

describe("whsec_ secrets", () => {
  it("generates a secret that decodes to a 32-byte key", () => {
    expect(secret.startsWith("whsec_")).toBe(true)
    expect(decodeSecret(secret)?.length).toBe(32)
  })

  it("rejects malformed secrets and out-of-range key sizes", () => {
    expect(decodeSecret("nope")).toBeNull()
    expect(decodeSecret("whsec_" + Buffer.alloc(23).toString("base64"))).toBeNull()
    expect(decodeSecret("whsec_" + Buffer.alloc(65).toString("base64"))).toBeNull()
    expect(decodeSecret("whsec_" + Buffer.alloc(24).toString("base64"))).not.toBeNull()
  })
})

describe("verifyWebhook", () => {
  const body = JSON.stringify({ eventId: "evt_1", name: "x" })

  it("accepts a valid signature inside the tolerance window", () => {
    expect(verifyWebhook(secret, headersFor(body), body, NOW)).toBe(true)
    expect(verifyWebhook(secret, headersFor(body, NOW - TIMESTAMP_TOLERANCE_S), body, NOW)).toBe(true)
  })

  it("rejects a stale or future timestamp", () => {
    expect(verifyWebhook(secret, headersFor(body, NOW - TIMESTAMP_TOLERANCE_S - 1), body, NOW)).toBe(false)
    expect(verifyWebhook(secret, headersFor(body, NOW + TIMESTAMP_TOLERANCE_S + 1), body, NOW)).toBe(false)
  })

  it("rejects a tampered body, another secret and a bad id", () => {
    expect(verifyWebhook(secret, headersFor(body), body + " ", NOW)).toBe(false)
    expect(verifyWebhook(generateSecret(), headersFor(body), body, NOW)).toBe(false)
    expect(verifyWebhook(secret, { ...headersFor(body), id: "evt_2" }, body, NOW)).toBe(false)
  })

  it("accepts when any space-separated candidate matches (key rotation)", () => {
    const good = headersFor(body)
    expect(verifyWebhook(secret, { ...good, signature: `v1,AAAA ${good.signature}` }, body, NOW)).toBe(true)
  })

  it("rejects a non-numeric timestamp, an empty signature and an unknown version", () => {
    expect(verifyWebhook(secret, { ...headersFor(body), timestamp: "abc" }, body, NOW)).toBe(false)
    expect(verifyWebhook(secret, { ...headersFor(body), signature: "" }, body, NOW)).toBe(false)
    expect(verifyWebhook(secret, { ...headersFor(body), signature: headersFor(body).signature.replace("v1,", "v2,") }, body, NOW)).toBe(false)
  })
})

/**
 * `dual-sign-rotation-window` — during secret rotation `signWebhook`
 * produces space-separated `v1,<sig>` segments, one per secret, each
 * individually verifiable against its own secret.
 */

import { createHmac } from "node:crypto"
import { describe, expect, it } from "vitest"

import { signWebhook, encodeWhsecSecret } from "../../webhook-egress/signing.js"

function hmac(msg: string, raw: Buffer): string {
  return `v1,${createHmac("sha256", raw).update(msg, "utf8").digest("base64")}`
}

describe("dual-sign-rotation-window", () => {
  const oldRaw = Buffer.from("old-key-0123456789abcdef0123456", "utf8")
  const newRaw = Buffer.from("new-key-0123456789abcdef0123456", "utf8")
  const olds = encodeWhsecSecret(oldRaw)
  const news = encodeWhsecSecret(newRaw)

  it("two secrets → two v1, segments", () => {
    const payload = new TextEncoder().encode('{"rotation":true}')
    const headers = signWebhook({ msgId: "evt_rot", timestamp: 100, payload, secrets: [olds, news] })
    const segments = headers["webhook-signature"].split(" ")
    expect(segments).toHaveLength(2)
    segments.forEach((s) => expect(s).toMatch(/^v1,/))
  })

  it("each segment verifies against its OWN secret (old appends work during the window)", () => {
    const payload = new TextEncoder().encode('{"rotation":true}')
    const headers = signWebhook({ msgId: "evt_rot", timestamp: 100, payload, secrets: [olds, news] })
    const [oldSeg, newSeg] = headers["webhook-signature"].split(" ")
    const text = `evt_rot.100.${new TextDecoder().decode(payload)}`
    expect(oldSeg).toBe(hmac(text, oldRaw))
    expect(newSeg).toBe(hmac(text, newRaw))
  })

  it("one secret → exactly one segment (no empty or stray segments)", () => {
    const payload = new TextEncoder().encode("x")
    const headers = signWebhook({ msgId: "evt_rot", timestamp: 100, payload, secrets: [news] })
    expect(headers["webhook-signature"].split(" ")).toHaveLength(1)
    expect(headers["webhook-signature"].startsWith("v1,")).toBe(true)
  })

  it("the two segments are actually different — the key material differs", () => {
    const payload = new TextEncoder().encode("x")
    const headers = signWebhook({ msgId: "evt_rot", timestamp: 100, payload, secrets: [olds, news] })
    const [a, b] = headers["webhook-signature"].split(" ")
    expect(a).not.toBe(b)
  })
})

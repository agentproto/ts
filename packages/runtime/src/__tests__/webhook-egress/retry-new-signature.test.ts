/**
 * `retry-new-signature` — every retry re-signs from the SAME bytes with a
 * FRESH timestamp: the `webhook-signature` (and `webhook-timestamp`) header
 * of attempt N+1 differs from attempt N while `webhook-id` (the event id)
 * stays stable (I1: consumers dedup on it).
 */

import { afterEach, describe, expect, it } from "vitest"

import {
  deliverEventEnvelope,
  type DeliveryReplay,
  type McpEventEnvelope,
  type SsrfFetchArgs,
} from "../../webhook-egress/delivery.js"
import { encodeWhsecSecret } from "../../webhook-egress/signing.js"

afterEach(() => {
  // no state
})


function hdr(h: Record<string, string>, key: string): string {
  const v = h[key]
  if (v === undefined) throw new Error(`missing ${key} header`)
  return v
}

describe("retry-new-signature", () => {
  const secret = encodeWhsecSecret(new TextEncoder().encode("freshsig-key-0123456789abcdef01"))
  const replay: DeliveryReplay = { subId: "sub_freshsig", callbackUrl: "https://listener.example.com/h", secrets: [secret] }
  const event: McpEventEnvelope = {
    eventId: "evt_freshsig",
    name: "github.pull_request.closed",
    timestamp: "2026-09-30T10:00:00.000Z",
    data: { subject: "pr/2" },
    cursor: null,
  }

  it("attempt 2 carries a new timestamp + different signature, same webhook-id and body", async () => {
    const seen: Array<{ id: string; ts: string; sig: string; body: string }> = []
    let call = 0
    let t = 1_000_000_000_000
    await deliverEventEnvelope(replay, event, {
      sleep: async () => {},
      now: () => (t += 1_500),
      fetch: async (_url: string, init: SsrfFetchArgs) => {
        const h = init.headers as Record<string, string>
        seen.push({ id: hdr(h, "webhook-id"), ts: hdr(h, "webhook-timestamp"), sig: hdr(h, "webhook-signature"), body: new TextDecoder().decode(init.body ?? new Uint8Array()) })
        call += 1
        return call === 2 ? { status: 200, body: "" } : { status: 502, body: "" }
      },
    })
    expect(seen).toHaveLength(2)
    const [first, second] = seen as [typeof seen[0], typeof seen[number]]
    expect(first.ts).not.toBe(second.ts)
    expect(first.sig).not.toBe(second.sig)
    expect(first.id).toBe("evt_freshsig") // I1 stable
    expect(second.id).toBe("evt_freshsig")
    expect(first.body).toBe(second.body)
  })

  it("signatures are recomputed from secret key material, not merely re-randomized: both verify independently", async () => {
    const seen: Record<string, string>[] = []
    const decode = Buffer.from("freshsig-key-0123456789abcdef01", "utf8")
    // The HMAC keys are the decoded (default utf8 here) bytes — the whsec
    // b64 key is the same material; independently verify both attempts.
    const { createHmac } = await import("node:crypto")
    let t = 1_000_000_000_000 + 3_000
    await deliverEventEnvelope(replay, event, {
      sleep: async () => {},
      now: () => (t += 1_500),
      fetch: async (_url, init) => {
        seen.push(init.headers as Record<string, string>)
        return { status: 502, body: "" }
      },
    })
    for (const h of seen) {
      const expected = `v1,${createHmac("sha256", decode).update(`${h["webhook-id"]}.${h["webhook-timestamp"]}.`, "utf8").update(Buffer.from(JSON.stringify(event), "utf8")).digest("base64")}`
      expect(h["webhook-signature"]).toBe(expected)
    }
  })

  it("attempts with distinct fresh timestamps even when closely spaced", async () => {
    let attempt = 0
    const headers: string[] = []
    await deliverEventEnvelope(replay, event, {
      sleep: async () => {},
      now: () => 1_000_000_000_000 + attempt * 1_500,
      fetch: async (_url, init) => {
        headers.push(hdr(init.headers as Record<string, string>, "webhook-signature"))
        attempt += 1
        return attempt <= 1 ? { status: 500, body: "" } : { status: 200, body: "" }
      },
    })
    expect(headers).toHaveLength(2)
    const first = headers[0]
    const secondHeader = headers[1]
    if (first === undefined || secondHeader === undefined) throw new Error("expected two attempts")
    expect(first).not.toBe(secondHeader)
  })
})

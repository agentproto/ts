/**
 * `retry-keeps-bytes` — I2 end to end: `deliverEventEnvelope` re-signs on
 * every retry with a FRESH timestamp, the signature header DIFFERS, but the
 * body bytes are bitwise identical across all attempts (one serialization).
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
  // no global state here — nothing to reset
})


function hdr(h: Record<string, string>, key: string): string {
  const v = h[key]
  if (v === undefined) throw new Error(`missing ${key} header`)
  return v
}

describe("retry-keeps-bytes", () => {
  const secret = encodeWhsecSecret(new TextEncoder().encode("bytes-ident-key-0123456789abcdef"))
  const replay: DeliveryReplay = { subId: "sub_bytes", callbackUrl: "https://listener.example.com/h", secrets: [secret] }

  function event(): McpEventEnvelope {
    return {
      eventId: "evt_bytes",
      name: "github.pull_request.opened",
      timestamp: "2026-09-30T10:00:00.000Z",
      data: { subject: "pr/1", action: "opened" },
      cursor: null,
    }
  }

  it("500 then 200 → two attempts, DIFFERENT signatures, IDENTICAL body bytes", async () => {
    const seen: Array<{ body: string; sig: string; ts: string }> = []
    let call = 0
    const result = await deliverEventEnvelope(replay, event(), {
      sleep: async () => {},
      now: (() => {
        let t = 1_000_000_000_000
        return () => (t += 1_500) // >1s apart → distinct wire timestamps
      })(),
      fetch: async (_url: string, init: SsrfFetchArgs) => {
        call += 1
        const h = init.headers as Record<string, string>
        seen.push({ body: new TextDecoder().decode(init.body ?? new Uint8Array()), sig: hdr(h, "webhook-signature"), ts: hdr(h, "webhook-timestamp") })
        return call === 1 ? { status: 500, body: "oops" } : { status: 200, body: "ok" }
      },
    })
    expect(result.ok).toBe(true)
    expect(result.ok ? result.delivery.attempts : 0).toBe(2)
    expect(seen).toHaveLength(2)
    const [first, second] = seen as [typeof seen[0], typeof seen[number]]
    expect(first.ts).not.toBe(second.ts) // fresh timestamp per attempt
    expect(first.sig).not.toBe(second.sig) // fresh signature per attempt
    expect(first.body).toBe(second.body) // BITWISE SAME BYTES (I2)
    expect(JSON.parse(first.body) as Record<string, unknown>).toEqual(JSON.parse(second.body) as Record<string, unknown>)
  })

  it("three failures then success → three identical bodies, four signatures", async () => {
    const seen: Array<{ sig: string; body: string }> = []
    let call = 0
    let t = 1_000_000_000_000
    const clock = (): number => (t += 2_000)
    const result = await deliverEventEnvelope(replay, event(), {
      sleep: async () => {},
      now: clock,
      fetch: async (_url, init) => {
        const h = init.headers as Record<string, string>
        seen.push({ sig: hdr(h, "webhook-signature"), body: new TextDecoder().decode(init.body ?? new Uint8Array()) })
        call += 1
        return call < 4 ? { status: 503, body: "" } : { status: 204, body: "" }
      },
    })
    expect(result.ok).toBe(true)
    expect(result.ok ? result.delivery.attempts : 0).toBe(4)
    const sigs = seen.map((s) => s.sig)
    const bodyStrs = seen.map((s) => s.body)
    expect(new Set(bodyStrs).size).toBe(1) // all identical (I2)
    expect(new Set(sigs).size).toBe(4) // every attempt freshly signed
  })
})

/**
 * `payload-clamp-256kib` — a serialized envelope over 262 144 bytes is
 * clamped BEFORE any signature: `data` is replaced with `{summary, subject}`
 * and the envelope gains `truncated: true`; the SIGNATURE is computed over
 * the CLAMPED bytes (not the original), and the clamped body fits the wire
 * clamp.
 */

import { afterEach, describe, expect, it } from "vitest"

import {
  deliverEventEnvelope,
  envelopeClampedBytes,
  serializeEnvelope,
  CLAMP_LIMIT_BYTES,
  type DeliveryReplay,
  type McpEventEnvelope,
  type SsrfFetchArgs,
} from "../../webhook-egress/delivery.js"
import { encodeWhsecSecret } from "../../webhook-egress/signing.js"

afterEach(() => {
  // no state
})

describe("payload-clamp-256kib", () => {
  const secret = encodeWhsecSecret(new TextEncoder().encode("clamp-key-0123456789abcdef012345"))
  const replay: DeliveryReplay = { subId: "sub_clamp", callbackUrl: "https://listener.example.com/h", secrets: [secret] }

  function oversizedEvent(): McpEventEnvelope {
    return {
      eventId: "evt_clamp",
      name: "github.issue.record",
      timestamp: "2026-09-30T10:00:00.000Z",
      data: { subject: "big-record", blob: "x".repeat(CLAMP_LIMIT_BYTES) },
      cursor: null,
    }
  }

  it("over-size envelope → envelopeClampedBytes flags clamped and shrinks data", () => {
    const originalJson = new TextDecoder().decode(serializeEnvelope(oversizedEvent()))
    expect(originalJson.length).toBeGreaterThan(CLAMP_LIMIT_BYTES)

    const { bytes, clamped } = envelopeClampedBytes(oversizedEvent())
    expect(clamped).toBe(true)
    expect(bytes.byteLength).toBeLessThanOrEqual(CLAMP_LIMIT_BYTES)

    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as McpEventEnvelope
    expect(parsed.truncated).toBe(true)
    expect(parsed.cursor).toBeNull()
    expect(Object.keys(parsed.data).sort()).toEqual(["subject", "summary"].sort())
    expect(parsed.data.summary).toMatch(/exceeded/i)
    expect(parsed.data.subject).toBe("big-record")
  })

  it("under-size envelope is passed through UNclamped and unmarked", () => {
    const small: McpEventEnvelope = { eventId: "evt_small", name: "n", timestamp: "t", data: {}, cursor: null }
    const { bytes, clamped } = envelopeClampedBytes(small)
    expect(clamped).toBe(false)
    expect(JSON.parse(new TextDecoder().decode(bytes)) as McpEventEnvelope).toEqual(small)
  })

  it("the delivered bytes after a retry carry `truncated: true` and stay within the clamp on EVERY attempt", async () => {
    const bodies: string[] = []
    let call = 0
    let t = 1_000_000_000_000
    const result = await deliverEventEnvelope(replay, oversizedEvent(), {
      sleep: async () => {},
      now: () => (t += 2_000),
      fetch: async (_url: string, init: SsrfFetchArgs) => {
        const raw = init.body ?? new Uint8Array()
        expect(raw.byteLength).toBeLessThanOrEqual(CLAMP_LIMIT_BYTES)
        bodies.push(new TextDecoder().decode(raw))
        call += 1
        return call === 1 ? { status: 500, body: "" } : { status: 200, body: "ok" }
      },
    })
    expect(result.ok).toBe(true)
    expect(result.ok ? result.delivery.attempts : 0).toBe(2)
    expect(bodies).toHaveLength(2)
    const first = JSON.parse(bodies[0] ?? "") as McpEventEnvelope
    expect(first.truncated).toBe(true)
    expect((bodies[0] ?? "") === (bodies[1] ?? "not-two")).toBe(true)
  })
})

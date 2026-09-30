/**
 * `retry-backoff-bounded` — the retry loop is exponential, BOUNDED in both
 * duration (cap) and attempt count (5): 250, 500, 1000, 2000, then 4000
 * capped forever; exactly 5 attempts from here to exhaustion.
 */

import { describe, expect, it } from "vitest"

import {
  deliverEventEnvelope,
  deliveryBackoffDelay,
  MAX_ATTEMPTS,
  type DeliveryReplay,
  type McpEventEnvelope,
} from "../../webhook-egress/delivery.js"
import { encodeWhsecSecret } from "../../webhook-egress/signing.js"

describe("retry-backoff-bounded", () => {
  const secret = encodeWhsecSecret(new TextEncoder().encode("backoff-key-0123456789abcdef012"))
  const replay: DeliveryReplay = { subId: "sub_backoff", callbackUrl: "https://listener.example.com/h", secrets: [secret] }
  const event: McpEventEnvelope = {
    eventId: "evt_backoff",
    name: "github.check_suite.completed",
    timestamp: "2026-09-30T10:00:00.000Z",
    data: {},
    cursor: null,
  }

  it("deliveryBackoffDelay grows exponentially and is CAPPED at 4000", () => {
    const delays: number[] = []
    for (let attempt = 0; attempt < 12; attempt++) delays.push(deliveryBackoffDelay(attempt))
    expect(delays[0]).toBe(250)
    expect(delays[1]).toBe(500)
    expect(delays[2]).toBe(1000)
    expect(delays[3]).toBe(2000)
    expect(delays[4]).toBe(4000)
    expect(delays[5]).toBe(4000)
    expect(delays[11]).toBe(4000)
    expect(new Set(delays.slice(4))).toEqual(new Set([4_000])) // forever bounded
  })

  it("exhaustion after exactly 5 attempts, sleeping once between each pair", async () => {
    const sleeps: number[] = []
    let calls = 0
    const result = await deliverEventEnvelope(replay, event, {
      sleep: async (ms: number) => {
        sleeps.push(ms)
      },
      fetch: async () => {
        calls += 1
        return { status: 503, body: "" }
      },
    })
    expect(result.ok).toBe(false)
    expect(calls).toBe(MAX_ATTEMPTS)
    expect(sleeps).toHaveLength(MAX_ATTEMPTS - 1)
    expect(sleeps).toEqual([500, 1000, 2000, 4000])
  })

  it("a retry that SUCCEEDS stops the loop early (no more sleeps after delivery)", async () => {
    let calls = 0
    const sleeps: number[] = []
    const result = await deliverEventEnvelope(replay, event, {
      sleep: async (ms: number) => {
        sleeps.push(ms)
      },
      fetch: async () => {
        calls += 1
        return calls === 3 ? { status: 201, body: "" } : { status: 500, body: "" }
      },
    })
    expect(result.ok).toBe(true)
    expect(calls).toBe(3)
    expect(result.ok ? result.delivery.attempts : 0).toBe(3)
    expect(sleeps).toEqual([500, 1000])
  })
})

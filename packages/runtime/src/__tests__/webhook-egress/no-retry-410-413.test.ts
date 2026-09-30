/**
 * `no-retry-410-413` — HTTP 410 (Gone / unsubscribed) and 413 (Payload Too
 * Large) are TERMINAL: the delivery loop stops immediately, exactly ONE
 * request is ever issued, and the failure carries the status as its reason.
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

describe("no-retry-410-413", () => {
  const secret = encodeWhsecSecret(new TextEncoder().encode("terminal-key-0123456789abcdef0"))
  const replay: DeliveryReplay = { subId: "sub_terminal", callbackUrl: "https://listener.example.com/h", secrets: [secret] }
  const event: McpEventEnvelope = {
    eventId: "evt_terminal",
    name: "github.pull_request.opened",
    timestamp: "2026-09-30T10:00:00.000Z",
    data: {},
    cursor: null,
  }

  it("410 → one attempt, ok:false, reason http_410, no backoff sleeps", async () => {
    let calls = 0
    const sleeps: number[] = []
    const result = await deliverEventEnvelope(replay, event, {
      sleep: async (ms: number) => {
        sleeps.push(ms)
      },
      fetch: async (_url: string, _init: SsrfFetchArgs) => {
        calls += 1
        return { status: 410, body: "gone" }
      },
    })
    expect(result).toEqual({
      ok: false,
      reason: "http_410",
      delivery: { attempts: 1, lastError: "terminal status 410", lastAt: expect.any(String) },
    })
    expect(calls).toBe(1)
    expect(sleeps).toHaveLength(0)
  })

  it("413 → one attempt, reason http_413", async () => {
    let calls = 0
    const result = await deliverEventEnvelope(replay, event, {
      sleep: async () => {},
      fetch: async () => {
        calls += 1
        return { status: 413, body: "too large" }
      },
    })
    expect(result.ok).toBe(false)
    expect(result.ok === false ? result.reason : "").toBe("http_413")
    expect(calls).toBe(1)
  })

  it("other 4xx are NOT terminal — e.g. 500-family still retries (contrast)", async () => {
    let calls = 0
    let t = 1_000_000_000_000
    const result = await deliverEventEnvelope(replay, event, {
      sleep: async () => {},
      now: () => (t += 2_000),
      fetch: async () => {
        calls += 1
        return calls < 5 ? { status: 502, body: "" } : { status: 200, body: "" }
      },
    })
    expect(result.ok).toBe(true)
    expect(calls).toBe(5) // retried up to the cap, then delivered
  })

  it("a 413 result preserves the DeliveryState the caller persists (W-B resume rule)", async () => {
    const result = await deliverEventEnvelope(replay, event, {
      sleep: async () => {},
      fetch: async () => ({ status: 413, body: "" }),
    })
    expect(result.ok).toBe(false)
    expect(result.ok === false ? result.delivery : {}).toMatchObject({ attempts: 1 })
  })
})

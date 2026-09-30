/**
 * `ssrf-same-fn-both-paths` — invariant I3: the challenge path and the
 * delivery path issue their outbound HTTPS through the ONE identical
 * `ssrfFetch` function. We prove the identity end to end: BOTH modules (with
 * no per-callsite injection) route through the same recording dispatcher.
 */

import { afterEach, describe, expect, it } from "vitest"

import { verifyCallback, resetChallengeCacheForTests } from "../../webhook-egress/challenge.js"
import { deliverEventEnvelope } from "../../webhook-egress/delivery.js"
import { setEgressDispatcherForTests, type EgressDispatcher } from "../../webhook-egress/ssrf-fetch.js"
import { encodeWhsecSecret } from "../../webhook-egress/signing.js"

afterEach(() => {
  setEgressDispatcherForTests(null)
  resetChallengeCacheForTests()
})

describe("ssrf-same-fn-both-paths", () => {
  const secret = encodeWhsecSecret(new TextEncoder().encode("gw-ab-key-0123456789abcdef0123"))

  it("challenge AND delivery both emerge through the same dispatcher gate", async () => {
    const calls: Array<string> = []
    const dispatcher: EgressDispatcher = async (req) => {
      const isChallenge = req.headers["X-MCP-Subscription-Id"] !== undefined
      const challengeBody = JSON.parse(new TextDecoder().decode(req.body ?? new Uint8Array())) as { challenge?: string }
      if (isChallenge) {
        calls.push(`challenge:${req.url}`)
        return { status: 200, body: JSON.stringify({ challenge: challengeBody.challenge }) }
      }
      calls.push(`delivery:${req.url}`)
      return { status: 200, body: "ok" }
    }
    setEgressDispatcherForTests(dispatcher)

    const outcome = await verifyCallback({
      principal: "daemon-bearer",
      url: "https://callback.example.com/hook",
      subscriptionId: "sub_samefn",
      secret,
    })
    expect(outcome.ok).toBe(true)
    resetChallengeCacheForTests() // force a real second check

    const result = await deliverEventEnvelope(
      { subId: "sub_samefn", callbackUrl: "https://listener.example.com/evt", secrets: [secret] },
      {
        eventId: "evt_same",
        name: "github.pull_request.opened",
        timestamp: "2026-09-30T10:00:00.000Z",
        data: { subject: "pr/1" },
        cursor: null,
      },
    )
    expect(result.ok).toBe(true)

    expect(calls).toEqual([
      "challenge:https://callback.example.com/hook",
      "delivery:https://listener.example.com/evt",
    ])
  })

  it("neither path bypasses the gate when the DNS policy fails — no per-callsite fork", async () => {
    setEgressDispatcherForTests(async () => {
      throw new Error("MUST NOT REACH THE DISPATCHER — host should have been blocked by the predicate")
    })
    const challenge = await verifyCallback({
      principal: "daemon-bearer",
      url: "https://10.0.0.1/loop", // literal private address — predicate blocks before any connect
      subscriptionId: "sub_samefn",
      secret,
    })
    expect(challenge.ok).toBe(false)
    expect(challenge.ok === false ? challenge.reason : "").toBe("ssrf_blocked")
    const delivery = await deliverEventEnvelope(
      { subId: "sub_samefn2", callbackUrl: "https://172.16.9.9/loop", secrets: [secret] },
      { eventId: "evt_x", name: "n", timestamp: "t", data: {}, cursor: null },
      { sleep: async () => {} }, // retries through the blocked gate stay instant in-test
    )
    expect(delivery.ok).toBe(false)
  })
})

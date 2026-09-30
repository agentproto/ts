/**
 * `challenge-fail-reason-categorized` — every rejection mode lands in
 * exactly one §3 challenge reason, in particular the three-column mapping:
 * SsrfFetchReason → ChallengeFailureReason → (`OK` JSON-RPC `data.reason`
 * of W-C uses the latter verbatim).
 *   non_https          → non_https
 *   private_target     → ssrf_blocked
 *   redirect           → ssrf_blocked
 *   timeout            → timeout
 *   connect            → timeout (detail preserved)
 * non-2xx responses → non_2xx; wrong echo → challenge_failed.
 */

import { afterEach, describe, expect, it } from "vitest"

import {
  verifyCallback,
  challengeReasonForSsrf,
  challengeCacheSize,
  resetChallengeCacheForTests,
  type SsrfFetchArgs,
} from "../../webhook-egress/challenge.js"
import { SsrfFetchError, type SsrfFetchReason } from "../../webhook-egress/ssrf-fetch.js"
import { encodeWhsecSecret } from "../../webhook-egress/signing.js"

afterEach(() => {
  resetChallengeCacheForTests()
})

describe("challenge-fail-reason-categorized", () => {
  const goodSecret = encodeWhsecSecret(new TextEncoder().encode("reason-matrix-key-0123456789ab01"))

  const ssrfMatrix: Array<[SsrfFetchReason, string]> = [
    ["non_https", "non_https"],
    ["private_target", "ssrf_blocked"],
    ["redirect", "ssrf_blocked"],
    ["timeout", "timeout"],
    ["connect", "timeout"],
  ]

  it("the three-column mapping covers ALL five SsrfFetchReasons — none unmapped", () => {
    for (const [ssrfReason, expected] of ssrfMatrix) {
      expect(challengeReasonForSsrf(ssrfReason)).toBe(expected)
    }
  })

  for (const [ssrfReason, expected] of ssrfMatrix) {
    it(`ssrfFetch throwing ${ssrfReason} surfaces reason "${expected}"`, async () => {
      const outcome = await verifyCallback(
        { principal: "p", url: "https://victim.example.com/c", subscriptionId: "sub_r", secret: goodSecret },
        {
          fetch: async () => {
            throw new SsrfFetchError(ssrfReason, `simulated ${ssrfReason}`)
          },
        },
      )
      expect(outcome.ok).toBe(false)
      expect(outcome.ok === false ? outcome.reason : "").toBe(expected)
      expect(outcome.ok === false ? outcome.detail : "").toContain(ssrfReason) // detail preserved
    })
    void it
  }

  it("non-2xx response (challenge not echoed) → non_2xx", async () => {
    const outcome = await verifyCallback(
      { principal: "p", url: "https://victim.example.com/c", subscriptionId: "sub_r", secret: goodSecret },
      { fetch: async () => ({ status: 403, body: "forbidden" }) },
    )
    expect(outcome).toMatchObject({ ok: false, reason: "non_2xx" })
  })

  it("2xx but wrong echo → challenge_failed", async () => {
    const outcome = await verifyCallback(
      { principal: "p", url: "https://victim.example.com/c", subscriptionId: "sub_r", secret: goodSecret },
      { fetch: async () => ({ status: 200, body: JSON.stringify({ challenge: "not-the-same" }) }) },
    )
    expect(outcome).toMatchObject({ ok: false, reason: "challenge_failed" })
  })

  it("2xx with non-JSON body → challenge_failed", async () => {
    const outcome = await verifyCallback(
      { principal: "p", url: "https://victim.example.com/c", subscriptionId: "sub_r", secret: goodSecret },
      { fetch: async () => ({ status: 200, body: "<html>nope</html>" }) },
    )
    expect(outcome).toMatchObject({ ok: false, reason: "challenge_failed" })
  })

  it("invalid whsec secret → categorized challenge_failed, never cached", async () => {
    for (const bad of ["garbage", "whsec_YQ==", "whsec_" + "A".repeat(90)]) {
      const outcome = await verifyCallback({
        principal: "p",
        url: "https://victim.example.com/c",
        subscriptionId: "sub_r",
        secret: bad,
      })
      expect(outcome).toMatchObject({ ok: false, reason: "challenge_failed" })
    }
    expect(challengeCacheSize()).toBe(0)
  })

  it("a 3xx answer (never chased) is a non-2xx rejection", async () => {
    const outcome = await verifyCallback(
      { principal: "p", url: "https://victim.example.com/c", subscriptionId: "sub_r", secret: goodSecret },
      { fetch: async () => ({ status: 302, body: "" }) },
    )
    expect(outcome).toMatchObject({ ok: false, reason: "non_2xx" })
  })
})

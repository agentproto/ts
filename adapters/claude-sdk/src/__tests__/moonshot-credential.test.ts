/**
 * Behaviour tests for the moonshot credential probe (the gate of the live
 * e2e in moonshot-turn.test.ts). The classification rule is the load-bearing
 * part, so all three branches are exercised here:
 *
 *   1. working credential   → supported (suite runs)
 *   2. definitively dead    → NOT supported (suite skips) — 401/402/403, and
 *      a 429 whose body says quota/credit exhaustion (the response observed
 *      live from a real no-credit key)
 *   3. ambiguous            → supported (suite RUNS and fails honestly) —
 *      network error, 5xx, unparseable body, transient 429, probe crash
 */
import { describe, expect, it } from "vitest"
import {
  classifyMoonshotResponse,
  probeMoonshotCredential,
  TEST_OVERRIDE,
  type CredentialProbe,
} from "./moonshot-credential.js"

describe("classifyMoonshotResponse", () => {
  it("branch 1 — a 2xx from the endpoint means the key transacts", () => {
    expect(classifyMoonshotResponse(200, '{"id":"msg_1"}')).toEqual({
      supported: true,
      reason: "",
    })
  })

  it("branch 2 — 401/402/403 are definitive rejections", () => {
    for (const status of [401, 402, 403]) {
      const verdict = classifyMoonshotResponse(status, '{"error":{"type":"authentication_error"}}')
      expect(verdict.supported).toBe(false)
      expect(verdict.reason).toContain(`HTTP ${status}`)
    }
  })

  it("branch 2 — a 429 whose body says quota/credit exhaustion is a dead key", () => {
    // The exact response observed live from a real no-credit key.
    const observed =
      '{"error":{"message":"Your account org-1 is suspended due to insufficient balance, please recharge your account","type":"exceeded_current_quota_error"}}'
    const verdict = classifyMoonshotResponse(429, observed)
    expect(verdict.supported).toBe(false)
    expect(verdict.reason).toContain("429")
  })

  it("branch 3 — a transient 429 does NOT skip", () => {
    const verdict = classifyMoonshotResponse(
      429,
      '{"error":{"message":"Too many requests, please retry later","type":"rate_limit_error"}}',
    )
    expect(verdict).toEqual({ supported: true, reason: "" })
  })

  it("branch 3 — a 5xx does NOT skip", () => {
    expect(classifyMoonshotResponse(500, "upstream error").supported).toBe(true)
    expect(classifyMoonshotResponse(503, "").supported).toBe(true)
  })

  it("branch 3 — a network/timeout failure (status 0) does NOT skip", () => {
    expect(
      classifyMoonshotResponse(0, "The operation was aborted due to timeout")
        .supported,
    ).toBe(true)
  })

  it("branch 3 — an unparseable/empty body on an unknown status does NOT skip", () => {
    expect(classifyMoonshotResponse(418, "").supported).toBe(true)
  })

  it("an absent key is reported as unsupported with the reason", () => {
    const verdict = classifyMoonshotResponse(-1, "")
    expect(verdict.supported).toBe(false)
    expect(verdict.reason).toContain("MOONSHOT_API_KEY not set")
  })
})

describe("probeMoonshotCredential", () => {
  it("honours the test-only override (forces the skip path on a capable host)", () => {
    const forced: CredentialProbe = {
      supported: false,
      reason: "forced-false for skip-path verification",
    }
    TEST_OVERRIDE.value = forced
    try {
      expect(probeMoonshotCredential()).toBe(forced)
    } finally {
      TEST_OVERRIDE.value = null
    }
  })

  it("caches the verdict per process (same object back on the second call)", () => {
    const first = probeMoonshotCredential()
    const second = probeMoonshotCredential()
    expect(second).toBe(first)
  })
})

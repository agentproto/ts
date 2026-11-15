/**
 * AIP-46 names the failure class of an exhausted account `quota-exhausted`; this
 * host calls it `usage-limit` (descriptors, `session:turn-retry` events and
 * stored presets already carry that name). `turnRetry.on` / `rotateOn` accept
 * the spec name as an alias and resolve it to the canonical class, so the change
 * is purely additive: `usage-limit` keeps working everywhere.
 */

import { describe, expect, it } from "vitest"
import type { SessionDescriptor } from "../sessions.js"
import { decideTurnRetry } from "../turn-retry.js"
import {
  canonicalTurnRetryClass,
  parseTurnRetryPolicy,
  resolveTurnRetryPolicy,
  turnRetryInputSchema,
} from "../turn-retry-policy.js"

const GO_EMPTY = "AI_APICallError: Insufficient balance. Top up at https://opencode.ai/console/org_X/billing?credits=1."

describe("quota-exhausted, the AIP-46 name of usage-limit", () => {
  it("is accepted in `on` and `rotateOn` and resolved to the canonical class", () => {
    const input = { on: ["quota-exhausted", "rate-limit"], rotate: [{ model: "m" }], rotateOn: ["quota-exhausted"] }
    expect(turnRetryInputSchema.safeParse(input).success).toBe(true)
    const policy = resolveTurnRetryPolicy(input as Parameters<typeof resolveTurnRetryPolicy>[0])
    expect(policy.on).toEqual(["usage-limit", "rate-limit"])
    expect(policy.rotateOn).toEqual(["usage-limit"])
  })

  it("dedupes the alias against the canonical name and keeps the canonical name working", () => {
    expect(resolveTurnRetryPolicy({ on: ["usage-limit", "quota-exhausted"] }).on).toEqual(["usage-limit"])
    expect(parseTurnRetryPolicy("quota-exhausted")?.on).toEqual(["usage-limit"])
    expect(parseTurnRetryPolicy("usage-limit")?.on).toEqual(["usage-limit"])
    expect(canonicalTurnRetryClass("quota-exhausted")).toBe("usage-limit")
    expect(canonicalTurnRetryClass("rate-limit")).toBe("rate-limit")
  })

  it("an unknown class is still refused", () => {
    expect(turnRetryInputSchema.safeParse({ on: ["quota-gone"] }).success).toBe(false)
    expect(parseTurnRetryPolicy("auth-failed")).toBeUndefined()
  })

  it("a policy written with the spec name diverts an empty wallet exactly like usage-limit", () => {
    const row = {
      id: "s1",
      kind: "agent-cli",
      status: "running",
      turnRetry: resolveTurnRetryPolicy({ on: ["quota-exhausted"] }),
    } as SessionDescriptor
    expect(decideTurnRetry(row, { kind: "turn-end", reason: "error", error: GO_EMPTY })).toMatchObject({
      action: "divert",
      errorClass: "usage-limit",
    })
  })
})

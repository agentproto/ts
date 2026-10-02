/**
 * `sub-id-canonical-jcs` — the deterministic subscription id is sha256 over
 * RFC 8785 (JCS) canonical JSON of the identity, so arg key order (top-level
 * AND nested) never mints two ids for one logical subscription.
 */

import { describe, expect, it } from "vitest"

import { canonicalizeJcs, subscriptionId } from "../../mcp-events/subscription-id.js"

const base = {
  principal: "daemon-bearer",
  callbackUrl: "https://receiver.example.com/mcp-events/cb",
  eventName: "github.pull_request.closed",
}

describe("sub-id-canonical-jcs", () => {
  it("same identity with different arg key order → identical id", () => {
    const a = subscriptionId({ ...base, args: { b: 2, a: 1, nested: { y: 1, x: 2 } } })
    const b = subscriptionId({ ...base, args: { a: 1, b: 2, nested: { x: 2, y: 1 } } })
    expect(a).toBe(b)
    expect(a).toMatch(/^sub_[0-9a-f]{32}$/)
  })

  it("canonicalizeJcs sorts keys recursively, keeps array order, uses ECMAScript numbers", () => {
    expect(canonicalizeJcs({ b: 1, a: { d: 4, c: 3 } })).toBe('{"a":{"c":3,"d":4},"b":1}')
    expect(canonicalizeJcs([3, { b: 1, a: 2 }])).toBe('[3,{"a":2,"b":1}]')
    expect(canonicalizeJcs(-0)).toBe("0")
    expect(canonicalizeJcs(1.5)).toBe("1.5")
    // Unicode minimization: non-ASCII stays literal, control chars escape.
    expect(canonicalizeJcs("café\n")).toBe('"café\\n"')
  })

  it("a changed identity component changes the id", () => {
    const id = subscriptionId({ ...base, args: { a: 1 } })
    expect(subscriptionId({ ...base, principal: "session:s1", args: { a: 1 } })).not.toBe(id)
    expect(subscriptionId({ ...base, callbackUrl: "https://other.example.com/cb", args: { a: 1 } })).not.toBe(id)
    expect(subscriptionId({ ...base, eventName: "github.check_suite.completed", args: { a: 1 } })).not.toBe(id)
    expect(subscriptionId({ ...base, args: { a: 2 } })).not.toBe(id)
  })

  it("refuses non-JSON values rather than hashing a phantom identity", () => {
    expect(() => canonicalizeJcs(Number.NaN)).toThrow(/non-finite/)
    expect(() => canonicalizeJcs({ a: undefined })).toThrow(/unsupported/)
  })
})

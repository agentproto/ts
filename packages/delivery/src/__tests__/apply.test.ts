import { describe, expect, it } from "vitest"

import { shouldApplyDelivery, shouldApplyEnvelope, typeMatches } from "../apply.js"

describe("delivery apply switch", () => {
  it("applies nothing when absent or empty", () => {
    expect(shouldApplyDelivery(undefined, "acme.deploy")).toBe(false)
    expect(shouldApplyDelivery({}, "acme.deploy")).toBe(false)
    expect(shouldApplyDelivery({ types: {} }, "acme.deploy")).toBe(false)
  })

  it("matches an exact type and a prefix glob", () => {
    expect(shouldApplyDelivery({ types: { "acme.deploy": true } }, "acme.deploy")).toBe(true)
    expect(shouldApplyDelivery({ types: { "acme.*": true } }, "acme.deploy.failed")).toBe(true)
    expect(shouldApplyDelivery({ types: { "*": true } }, "anything.at.all")).toBe(true)
    expect(shouldApplyDelivery({ types: { "acme.*": true } }, "other.deploy")).toBe(false)
  })

  it("lets an exact key beat every glob, including a disabling exact", () => {
    expect(
      shouldApplyDelivery({ types: { "acme.*": true, "acme.deploy": false } }, "acme.deploy"),
    ).toBe(false)
    expect(
      shouldApplyDelivery({ types: { "*": false, "acme.deploy": true } }, "acme.deploy"),
    ).toBe(true)
  })

  it("lets the longest matching prefix win deterministically", () => {
    const types = { "*": true, "acme.*": false, "acme.deploy.*": true }
    expect(shouldApplyDelivery({ types }, "acme.deploy.done")).toBe(true)
    expect(shouldApplyDelivery({ types }, "acme.deploy.failed")).toBe(true)
    expect(shouldApplyDelivery({ types }, "acme.rollback")).toBe(false)
    expect(shouldApplyDelivery({ types }, "other.event")).toBe(true)
  })

  it("does not treat a false key as an off-match for siblings", () => {
    expect(
      shouldApplyDelivery({ types: { "acme.*": true, "acme.build": false } }, "acme.build.done"),
    ).toBe(true)
  })

  it("exposes the envelope convenience overload and glob helper", () => {
    expect(shouldApplyEnvelope({ types: { "acme.*": true } }, { type: "acme.deploy" })).toBe(true)
    expect(typeMatches("acme.*", "acme.deploy")).toBe(true)
    expect(typeMatches("acme.*", "acme")).toBe(false)
    expect(typeMatches("acme.deploy", "acme.deploy")).toBe(true)
    expect(typeMatches("*", "anything")).toBe(true)
  })
})

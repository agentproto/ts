import { describe, it, expect } from "vitest"
import {
  definePolicy,
  parsePolicyManifest,
  policyFromManifest,
} from "../index.js"

describe("definePolicy (AIP-7)", () => {
  it("produces a frozen handle with defaults applied", () => {
    const policy = definePolicy({
      slug: "invoice-cap-500eur",
      name: "Invoice cap 500 EUR",
    })
    expect(policy.slug).toBe("invoice-cap-500eur")
    expect(policy.name).toBe("Invoice cap 500 EUR")
    expect(policy.schema).toBe("agentgovernance/v1")
    expect(policy.doctype).toBe("policy")
    expect(policy.threshold).toBe("single")
    expect(policy.appliesTo).toEqual([])
    expect(policy.caps).toEqual([])
    expect(policy.requiredSignatures).toEqual([])
    expect(Object.isFrozen(policy)).toBe(true)
  })

  it("rejects invalid slug (uppercase)", () => {
    expect(() =>
      definePolicy({ slug: "BadCaps", name: "x" }),
    ).toThrow(/definePolicy \(AIP-7\): invalid id 'BadCaps'/)
  })

  it("rejects invalid slug (underscore — only dashes allowed)", () => {
    expect(() =>
      definePolicy({ slug: "has_underscore", name: "x" }),
    ).toThrow(/invalid id 'has_underscore'/)
  })

  it("rejects empty name (spec-specific validate)", () => {
    expect(() =>
      definePolicy({ slug: "ok", name: "" }),
    ).toThrow(/name must be a non-empty string/)
  })

  it("does NOT enforce description length (description is optional in AIP-7)", () => {
    const policy = definePolicy({
      slug: "ok",
      name: "OK",
      // No description supplied — should not throw.
    })
    expect(policy.description).toBeUndefined()

    const long = definePolicy({
      slug: "long",
      name: "Long",
      description: "x".repeat(5000), // would fail AIP-14's 2000 cap, fine here
    })
    expect(long.description).toBe("x".repeat(5000))
  })

  it("rejects threshold='weighted_threshold' without requiredWeight", () => {
    expect(() =>
      definePolicy({
        slug: "weighted",
        name: "Weighted",
        threshold: "weighted_threshold",
      }),
    ).toThrow(
      /threshold='weighted_threshold' requires requiredWeight/,
    )
  })

  it("accepts threshold='weighted_threshold' with requiredWeight", () => {
    const policy = definePolicy({
      slug: "weighted",
      name: "Weighted",
      threshold: "weighted_threshold",
      requiredWeight: 0.66,
    })
    expect(policy.requiredWeight).toBe(0.66)
  })

  it("error prefix carries the AIP number", () => {
    expect(() => definePolicy({ slug: "BAD", name: "x" })).toThrow(
      /definePolicy \(AIP-7\)/,
    )
  })
})

describe("policyFromManifest", () => {
  const SAMPLE = `---
schema: agentgovernance/v1
doctype: policy
slug: invoice-cap-500eur
name: Invoice cap 500 EUR
description: |
  Operators may issue invoices up to 500 EUR without further approval.
appliesTo:
  - actorKind: operator
    actionType: agency.issue_invoice
caps:
  - field: amount
    max: 500
    currency: EUR
threshold: single
metadata:
  vendor.namespace: katchy
---

# Invoice cap 500 EUR
Body content explaining the policy.
`

  it("produces a typed handle from a POLICY.md source", () => {
    const manifest = parsePolicyManifest(SAMPLE)
    const policy = policyFromManifest(manifest)
    expect(policy.slug).toBe("invoice-cap-500eur")
    expect(policy.name).toBe("Invoice cap 500 EUR")
    expect(policy.threshold).toBe("single")
    expect(policy.caps).toHaveLength(1)
    const cap = policy.caps[0]
    expect(cap).toBeDefined()
    expect(cap?.max).toBe(500)
    expect(policy.metadata).toEqual({ "vendor.namespace": "katchy" })
    expect(Object.isFrozen(policy)).toBe(true)
  })

  it("propagates the .refine() — weighted_threshold without requiredWeight is rejected at parse time", () => {
    const bad = `---
schema: agentgovernance/v1
doctype: policy
slug: weighted-no-weight
name: x
threshold: weighted_threshold
---
`
    expect(() => parsePolicyManifest(bad)).toThrow(
      /weighted_threshold/,
    )
  })

  it("rejects manifests with missing frontmatter", () => {
    expect(() => parsePolicyManifest("body only")).toThrow(
      /missing or empty frontmatter/,
    )
  })

  it("rejects manifests with invalid slug shape", () => {
    const bad = `---
schema: agentgovernance/v1
doctype: policy
slug: NOT-A-SLUG
name: x
---
`
    expect(() => parsePolicyManifest(bad)).toThrow(/slug/)
  })
})

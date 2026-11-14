import { describe, it, expect } from "vitest"
import { defineGovernance } from "../../index.js"
import { definePolicy } from "../index.js"

describe("defineGovernance (AIP-7, AIP-70 registry name)", () => {
  it("builds the same handle as definePolicy", () => {
    const definition = {
      slug: "invoice-cap-500eur",
      name: "Invoice cap 500 EUR",
      caps: [{ field: "amount", max: 500, currency: "EUR" }],
    }

    const governance = defineGovernance(definition)
    const policy = definePolicy(definition)

    expect(governance).toEqual(policy)
    expect(governance.schema).toBe("governance/v1")
    expect(governance.doctype).toBe("policy")
  })
})

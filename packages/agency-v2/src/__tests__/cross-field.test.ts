import { describe, it, expect } from "vitest"
import { defineAgencyV2 } from "../define-agency-v2.js"

// AIP-21 cross-field rule:
//   appliesTo: [≥1 entry]   ⇒ extends: <required>
// Pass minimal name + description to clear the createDoctype gate;
// the structural rule fires before the zod check.
describe("defineAgencyV2 — cross-field rules", () => {
  it("rejects appliesTo non-empty without extends", () => {
    expect(() =>
      defineAgencyV2({
        name: "smoke",
        description: "x",
        appliesTo: ["operator-x"],
        // extends omitted
      } as never),
    ).toThrow(/appliesTo is non-empty — extends MUST be set/)
  })
})

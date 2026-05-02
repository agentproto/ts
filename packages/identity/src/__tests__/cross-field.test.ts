import { describe, it, expect } from "vitest"
import { defineIdentity } from "../define-identity.js"

// AIP-23 cross-field rule:
//   appliesTo: [≥1 entry]   ⇒ extends: <required>
// Pass minimal name to clear the createDoctype id check; the
// schema-level zod fires AFTER ours so we still see the rule's error.
describe("defineIdentity — cross-field rules", () => {
  it("rejects appliesTo non-empty without extends", () => {
    expect(() =>
      defineIdentity({
        name: "smoke",
        description: "x",
        appliesTo: ["operator-x"],
        // extends omitted
      } as never),
    ).toThrow(/appliesTo is non-empty — extends MUST be set/)
  })
})

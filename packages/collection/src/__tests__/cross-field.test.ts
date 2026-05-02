import { describe, it, expect } from "vitest"
import { defineCollection } from "../define-collection.js"

// AIP-18 cross-field rule:
//   appliesTo: [≥1 entry]   ⇒ extends: <required>
// Pass minimal id to clear the createDoctype id check; the
// schema-level zod fires AFTER ours so we still see the rule's error.
describe("defineCollection — cross-field rules", () => {
  it("rejects appliesTo non-empty without extends", () => {
    expect(() =>
      defineCollection({
        id: "smoke",
        description: "x",
        appliesTo: ["operator-x"],
        // extends omitted
      } as never),
    ).toThrow(/appliesTo is non-empty — extends MUST be set/)
  })
})

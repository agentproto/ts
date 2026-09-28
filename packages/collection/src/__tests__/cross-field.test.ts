import { describe, it, expect } from "vitest"
import { defineCollection } from "../define-collection.js"

// AIP-18 cross-field rule:
//   appliesTo: [≥1 entry]   ⇒ extends: <required>
// The def below is otherwise a well-formed collection.schema/v1 doc (valid
// name/title/description/version) so it clears createDoctype's identity
// check and reaches `validate()`, whose cross-field check runs BEFORE the
// schema-derived zod parse — we see the cross-field error, not a zod
// cascade about a missing `extends`.
describe("defineCollection — cross-field rules", () => {
  it("rejects appliesTo non-empty without extends", () => {
    expect(() =>
      defineCollection({
        schema: "collection.schema/v1",
        name: "smoke",
        title: "Smoke",
        description: "x",
        version: "1.0.0",
        appliesTo: ["ws://workspaces/smoke"],
        // extends omitted
      } as never),
    ).toThrow(/appliesTo is non-empty — extends MUST be set/)
  })
})

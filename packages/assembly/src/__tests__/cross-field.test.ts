import { describe, it, expect } from "vitest"
import { defineAssembly } from "../define-assembly.js"

// AIP-24 cross-field rules:
//   1. appliesTo: [≥1 entry]                          ⇒ extends: required
//   2. defaults.triggerHeuristic === "periodic"       ⇒ defaults.triggerInterval_ms: required
// Tested at the contract level — we don't construct a full valid def,
// we just verify the rule fires before zod validation completes.
describe("defineAssembly — cross-field rules", () => {
  it("rejects appliesTo non-empty without extends", () => {
    expect(() =>
      defineAssembly({
        name: "smoke",
        description: "x",
        appliesTo: ["operator-x"],
        // extends omitted
      } as never),
    ).toThrow(/appliesTo is non-empty — extends MUST be set/)
  })

  it("rejects defaults.triggerHeuristic='periodic' without triggerInterval_ms", () => {
    expect(() =>
      defineAssembly({
        name: "smoke",
        description: "x",
        defaults: { triggerHeuristic: "periodic" },
      } as never),
    ).toThrow(
      /defaults\.triggerHeuristic='periodic' requires defaults\.triggerInterval_ms/,
    )
  })
})

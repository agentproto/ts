import { describe, it, expect } from "vitest"
import { defineOperator } from "../define-operator.js"

describe("defineOperator (AIP-9)", () => {
  it("produces a frozen handle with defaults applied", () => {
    const handle = defineOperator({
      id: "smoke",
      description: "Smoke-test operator.",
    })
    expect(handle.id).toBe("smoke")
    expect(Object.isFrozen(handle)).toBe(true)
  })

  it("rejects invalid id (uppercase)", () => {
    expect(() =>
      defineOperator({ id: "BadCaps", description: "x" }),
    ).toThrow(/defineOperator \(AIP-9\): invalid id 'BadCaps'/)
  })

  it("rejects empty description", () => {
    expect(() =>
      defineOperator({ id: "ok", description: "" }),
    ).toThrow(/description must be 1–2000 chars/)
  })

  // TODO: spec-9-specific tests for build()/validate() once those land.
})

import { describe, it, expect } from "vitest"
import { defineSandbox } from "../define-sandbox.js"

describe("defineSandbox (AIP-36)", () => {
  it("produces a frozen handle with defaults applied", () => {
    const handle = defineSandbox({
      id: "smoke",
      description: "Smoke-test sandbox.",
    } as never)
    expect(handle.id).toBe("smoke")
    expect(Object.isFrozen(handle)).toBe(true)
  })

  it("rejects invalid id (uppercase)", () => {
    expect(() =>
      defineSandbox({ id: "BadCaps", description: "x" } as never),
    ).toThrow(/defineSandbox \(AIP-36\): invalid id 'BadCaps'/)
  })

  it("rejects empty description", () => {
    expect(() =>
      defineSandbox({ id: "ok", description: "" } as never),
    ).toThrow(/description must be 1–2000 chars/)
  })

  // TODO: spec-36-specific tests for build()/validate() once those land.
})

import { describe, it, expect } from "vitest"
import { defineStorage } from "../define-storage.js"

describe("defineStorage (AIP-35)", () => {
  it("produces a frozen handle with defaults applied", () => {
    const handle = defineStorage({
      id: "smoke",
      description: "Smoke-test storage.",
    } as never)
    expect(handle.id).toBe("smoke")
    expect(Object.isFrozen(handle)).toBe(true)
  })

  it("rejects invalid id (uppercase)", () => {
    expect(() =>
      defineStorage({ id: "BadCaps", description: "x" } as never),
    ).toThrow(/defineStorage \(AIP-35\): invalid id 'BadCaps'/)
  })

  it("rejects empty description", () => {
    expect(() =>
      defineStorage({ id: "ok", description: "" } as never),
    ).toThrow(/description must be 1–2000 chars/)
  })

  // TODO: spec-35-specific tests for build()/validate() once those land.
})

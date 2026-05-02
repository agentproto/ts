import { describe, it, expect } from "vitest"
import { defineLifecycle } from "../define-lifecycle.js"

describe("defineLifecycle (AIP-37)", () => {
  it("produces a frozen handle with defaults applied", () => {
    const handle = defineLifecycle({
      id: "smoke",
      description: "Smoke-test lifecycle.",
    } as never)
    expect(handle.id).toBe("smoke")
    expect(Object.isFrozen(handle)).toBe(true)
  })

  it("rejects invalid id (uppercase)", () => {
    expect(() =>
      defineLifecycle({ id: "BadCaps", description: "x" } as never),
    ).toThrow(/defineLifecycle \(AIP-37\): invalid id 'BadCaps'/)
  })

  it("rejects empty description", () => {
    expect(() =>
      defineLifecycle({ id: "ok", description: "" } as never),
    ).toThrow(/description must be 1–2000 chars/)
  })

  // TODO: spec-37-specific tests for build()/validate() once those land.
})

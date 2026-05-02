import { describe, it, expect } from "vitest"
import { defineWorkspace } from "../define-workspace.js"

describe("defineWorkspace (AIP-34)", () => {
  it("produces a frozen handle with defaults applied", () => {
    const handle = defineWorkspace({
      id: "smoke",
      description: "Smoke-test workspace.",
    } as never)
    expect(handle.id).toBe("smoke")
    expect(Object.isFrozen(handle)).toBe(true)
  })

  it("rejects invalid id (uppercase)", () => {
    expect(() =>
      defineWorkspace({ id: "BadCaps", description: "x" } as never),
    ).toThrow(/defineWorkspace \(AIP-34\): invalid id 'BadCaps'/)
  })

  it("rejects empty description", () => {
    expect(() =>
      defineWorkspace({ id: "ok", description: "" } as never),
    ).toThrow(/description must be 1–2000 chars/)
  })

  // TODO: spec-34-specific tests for build()/validate() once those land.
})

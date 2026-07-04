import { describe, expect, it } from "vitest"
import { timingSafeEqualStrings } from "./timing-safe.js"

describe("timingSafeEqualStrings", () => {
  it("returns true for identical strings", () => {
    expect(timingSafeEqualStrings("Bearer abc123", "Bearer abc123")).toBe(true)
  })

  it("returns false for different strings of the same length", () => {
    expect(timingSafeEqualStrings("Bearer abc123", "Bearer abc124")).toBe(false)
  })

  it("returns false without throwing for different-length strings", () => {
    expect(() => timingSafeEqualStrings("short", "a-much-longer-string")).not.toThrow()
    expect(timingSafeEqualStrings("short", "a-much-longer-string")).toBe(false)
  })

  it("returns true for two empty strings", () => {
    expect(timingSafeEqualStrings("", "")).toBe(true)
  })

  it("returns false when one side is empty", () => {
    expect(timingSafeEqualStrings("", "Bearer abc123")).toBe(false)
  })

  it("is case-sensitive", () => {
    expect(timingSafeEqualStrings("Bearer ABC", "Bearer abc")).toBe(false)
  })
})

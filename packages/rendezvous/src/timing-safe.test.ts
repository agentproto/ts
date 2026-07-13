import { describe, it, expect } from "vitest"
import { timingSafeEqualStrings } from "./timing-safe.js"

describe("timingSafeEqualStrings", () => {
  it("returns true for equal strings", () => {
    expect(timingSafeEqualStrings("abc123", "abc123")).toBe(true)
    expect(timingSafeEqualStrings("", "")).toBe(true)
  })

  it("returns false for different strings, including different lengths", () => {
    expect(timingSafeEqualStrings("abc123", "abc124")).toBe(false)
    expect(timingSafeEqualStrings("short", "a-much-longer-token")).toBe(false)
    expect(timingSafeEqualStrings("abc", "")).toBe(false)
  })
})

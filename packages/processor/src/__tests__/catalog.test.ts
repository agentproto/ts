import { describe, expect, it } from "vitest"
import { resolveRedactor } from "../catalog.js"
import type { JsonValue } from "../types.js"

const ctx = { field: "metadata" } as const

describe("resolveRedactor", () => {
  it("resolves undefined to the passthrough none redactor", () => {
    const redactor = resolveRedactor()
    const input: JsonValue = { password: "hunter2" }
    expect(redactor.slug).toBe("none")
    expect(redactor.redact(input, ctx)).toEqual(input)
  })

  it("resolves the 'none' slug to the passthrough redactor", () => {
    const redactor = resolveRedactor("none")
    const input: JsonValue = { password: "hunter2" }
    expect(redactor.redact(input, ctx)).toEqual(input)
  })

  it("resolves an empty array to the passthrough none redactor", () => {
    const redactor = resolveRedactor([])
    expect(redactor.slug).toBe("none")
  })

  it("resolves a bare slug string via the catalog", () => {
    const redactor = resolveRedactor("deny-list")
    const result = redactor.redact({ token: "abc" }, ctx)
    expect(result).toEqual({ token: "[redacted]" })
  })

  it("resolves an object spec with options", () => {
    const redactor = resolveRedactor({ slug: "deny-list", options: { placeholder: "***" } })
    const result = redactor.redact({ token: "abc" }, ctx)
    expect(result).toEqual({ token: "***" })
  })

  it("resolves an array spec by chaining in order", () => {
    const redactor = resolveRedactor([
      "deny-list",
      { slug: "truncate", options: { maxStringLength: 5 } },
    ])
    const result = redactor.redact({ token: "abc", note: "abcdefghij" }, ctx)
    expect(result).toEqual({ token: "[reda…[+5 chars]", note: "abcde…[+5 chars]" })
  })

  it("throws on an unknown slug, listing known slugs", () => {
    expect(() => resolveRedactor("does-not-exist")).toThrow(/unknown redactor slug/)
    expect(() => resolveRedactor("does-not-exist")).toThrow(/none/)
  })

  it("throws when object-spec options are not a JSON object", () => {
    expect(() => resolveRedactor({ slug: "deny-list", options: "nope" })).toThrow(
      /must be a JSON object/,
    )
  })
})

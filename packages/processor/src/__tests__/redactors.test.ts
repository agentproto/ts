import { describe, expect, it } from "vitest"
import { chainRedactors, denyListRedactor, truncateRedactor } from "../redactors.js"
import type { JsonValue } from "../types.js"

const ctx = { field: "metadata" } as const

describe("denyListRedactor", () => {
  it("masks matching keys at the top level", () => {
    const redactor = denyListRedactor()
    const input: JsonValue = { username: "alice", password: "hunter2" }
    const result = redactor.redact(input, ctx)
    expect(result).toEqual({ username: "alice", password: "[redacted]" })
  })

  it("masks matching keys at any depth, including inside arrays", () => {
    const redactor = denyListRedactor()
    const input: JsonValue = {
      user: {
        name: "bob",
        keys: [{ apiKey: "abc123", note: "keep me" }, { token: "xyz" }],
      },
    }
    const result = redactor.redact(input, ctx)
    expect(result).toEqual({
      user: {
        name: "bob",
        keys: [{ apiKey: "[redacted]", note: "keep me" }, { token: "[redacted]" }],
      },
    })
  })

  it("leaves non-matching keys untouched", () => {
    const redactor = denyListRedactor()
    const input: JsonValue = { id: 1, active: true, notes: null, tags: ["a", "b"] }
    const result = redactor.redact(input, ctx)
    expect(result).toEqual(input)
  })

  it("does not mutate the input", () => {
    const redactor = denyListRedactor()
    const input: JsonValue = { password: "hunter2", nested: { secret: "shh" } }
    const snapshot = JSON.parse(JSON.stringify(input))
    redactor.redact(input, ctx)
    expect(input).toEqual(snapshot)
  })

  it("supports a custom placeholder", () => {
    const redactor = denyListRedactor({ placeholder: "***" })
    const input: JsonValue = { token: "abc" }
    const result = redactor.redact(input, ctx)
    expect(result).toEqual({ token: "***" })
  })

  it("supports extraKeys as strings and RegExp", () => {
    const redactor = denyListRedactor({ extraKeys: ["custom-field", /^ssn$/i] })
    const input: JsonValue = { "custom-field": "x", ssn: "111-22-3333", other: "keep" }
    const result = redactor.redact(input, ctx)
    expect(result).toEqual({ "custom-field": "[redacted]", ssn: "[redacted]", other: "keep" })
  })
})

describe("truncateRedactor", () => {
  it("caps a long string", () => {
    const redactor = truncateRedactor({ maxStringLength: 10 })
    const input: JsonValue = "0123456789ABCDEF"
    const result = redactor.redact(input, ctx)
    expect(result).toBe("0123456789…[+6 chars]")
  })

  it("leaves a short string unchanged", () => {
    const redactor = truncateRedactor({ maxStringLength: 10 })
    const result = redactor.redact("short", ctx)
    expect(result).toBe("short")
  })

  it("caps a long array", () => {
    const redactor = truncateRedactor({ maxArrayLength: 3 })
    const input: JsonValue = [1, 2, 3, 4, 5]
    const result = redactor.redact(input, ctx)
    expect(result).toEqual([1, 2, 3, "…[+2 items]"])
  })

  it("leaves a short array unchanged", () => {
    const redactor = truncateRedactor({ maxArrayLength: 3 })
    const result = redactor.redact([1, 2], ctx)
    expect(result).toEqual([1, 2])
  })

  it("leaves non-string, non-array values untouched", () => {
    const redactor = truncateRedactor()
    expect(redactor.redact(42, ctx)).toBe(42)
    expect(redactor.redact(true, ctx)).toBe(true)
    expect(redactor.redact(null, ctx)).toBe(null)
  })

  it("recurses into nested objects and arrays", () => {
    const redactor = truncateRedactor({ maxStringLength: 5, maxArrayLength: 2 })
    const input: JsonValue = {
      long: "abcdefghij",
      items: [1, 2, 3, 4],
      nested: { deeper: "abcdefghij" },
    }
    const result = redactor.redact(input, ctx)
    expect(result).toEqual({
      long: "abcde…[+5 chars]",
      items: [1, 2, "…[+2 items]"],
      nested: { deeper: "abcde…[+5 chars]" },
    })
  })

  it("does not mutate the input", () => {
    const redactor = truncateRedactor({ maxStringLength: 5, maxArrayLength: 2 })
    const input: JsonValue = { long: "abcdefghij", items: [1, 2, 3, 4] }
    const snapshot = JSON.parse(JSON.stringify(input))
    redactor.redact(input, ctx)
    expect(input).toEqual(snapshot)
  })
})

describe("chainRedactors", () => {
  it("applies deny-list then truncate, in order", () => {
    const chain = chainRedactors([
      denyListRedactor(),
      truncateRedactor({ maxStringLength: 5 }),
    ])
    const input: JsonValue = { password: "hunter2", note: "abcdefghij" }
    const result = chain.redact(input, ctx)
    expect(result).toEqual({ password: "[reda…[+5 chars]", note: "abcde…[+5 chars]" })
  })

  it("defaults its slug to the joined member slugs", () => {
    const chain = chainRedactors([denyListRedactor(), truncateRedactor()])
    expect(chain.slug).toBe("deny-list+truncate")
  })

  it("accepts an explicit slug", () => {
    const chain = chainRedactors([denyListRedactor(), truncateRedactor()], "custom")
    expect(chain.slug).toBe("custom")
  })
})

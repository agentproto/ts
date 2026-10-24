import { describe, expect, it } from "vitest"
import { valueScanRedactor } from "../redactors.js"
import { resolveRedactor } from "../catalog.js"
import type { JsonValue } from "../types.js"

const ctx = { field: "metadata" } as const

describe("valueScanRedactor", () => {
  it("masks a secret embedded in an INNOCUOUS key's value (what deny-list misses)", () => {
    const redactor = valueScanRedactor()
    const input: JsonValue = { note: "remember to use sk-live-ABCDEFGHIJKLMNOP1234 for prod" }
    const result = redactor.redact(input, ctx)
    expect(result).toEqual({ note: "remember to use [redacted] for prod" })
  })

  it("keeps the Bearer/Basic scheme word and masks only the token", () => {
    const redactor = valueScanRedactor()
    const input: JsonValue = "Authorization: Bearer abcDEF123456ghiJKL789mno"
    expect(redactor.redact(input, ctx)).toBe("Authorization: Bearer [redacted]")
  })

  it("masks JWTs, AWS keys, GitHub tokens, and PEM private keys", () => {
    const redactor = valueScanRedactor()
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w"
    expect(redactor.redact(jwt, ctx)).toBe("[redacted]")
    expect(redactor.redact("id AKIAIOSFODNN7EXAMPLE here", ctx)).toBe("id [redacted] here")
    expect(redactor.redact("ghp_1234567890abcdefghijklmnopqrstuvwxyz12", ctx)).toBe("[redacted]")
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKj\n-----END RSA PRIVATE KEY-----"
    expect(redactor.redact(pem, ctx)).toBe("[redacted]")
  })

  it("leaves ordinary text untouched (no false positives on prose)", () => {
    const redactor = valueScanRedactor()
    const input: JsonValue = { msg: "the skater took a basic approach to the token economy" }
    expect(redactor.redact(input, ctx)).toEqual(input)
  })

  it("recurses into nested objects and arrays without mutating input", () => {
    const redactor = valueScanRedactor()
    const input: JsonValue = { items: [{ v: "key sk-ant-ABCDEFGHIJKLMNOP1234 x" }, "clean"] }
    const snapshot = JSON.parse(JSON.stringify(input)) as JsonValue
    const result = redactor.redact(input, ctx)
    expect(result).toEqual({ items: [{ v: "key [redacted] x" }, "clean"] })
    expect(input).toEqual(snapshot)
  })

  it("honours a custom placeholder", () => {
    const redactor = valueScanRedactor({ placeholder: "***" })
    expect(redactor.redact("token sk-live-ABCDEFGHIJKLMNOP1234", ctx)).toBe("token ***")
  })
})

describe("catalog: value-scan + secrets slugs", () => {
  it("resolves the value-scan slug", () => {
    const redactor = resolveRedactor("value-scan")
    expect(redactor.slug).toBe("value-scan")
    expect(redactor.redact({ note: "sk-live-ABCDEFGHIJKLMNOP1234" }, ctx)).toEqual({
      note: "[redacted]",
    })
  })

  it("secrets slug masks BOTH a denied key AND a value-embedded secret", () => {
    const redactor = resolveRedactor("secrets")
    expect(redactor.slug).toBe("secrets")
    const input: JsonValue = {
      password: "hunter2",
      note: "backup key sk-live-ABCDEFGHIJKLMNOP1234 stored offsite",
    }
    expect(redactor.redact(input, ctx)).toEqual({
      password: "[redacted]",
      note: "backup key [redacted] stored offsite",
    })
  })
})

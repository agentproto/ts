/**
 * `expiresAt` write-time normalization + read-time fail-closed guard.
 *
 * `Date.parse("garbage")` is NaN, and `NaN <= now` is always false — without
 * these guards an invalid persisted timestamp would make a follow/sentinel
 * immortal and silently defeat the bounded-lifetime backstop.
 */

import { describe, expect, it } from "vitest"

import { isExpiresAtReached, normalizeExpiresAt } from "../expires-at.js"

const NOW = Date.parse("2026-01-01T00:00:00.000Z")

describe("normalizeExpiresAt", () => {
  it("returns a parseable timestamp unchanged", () => {
    expect(normalizeExpiresAt("2027-01-01T00:00:00.000Z")).toBe(
      "2027-01-01T00:00:00.000Z",
    )
  })

  it("drops an unparseable value so the store's default TTL applies", () => {
    expect(normalizeExpiresAt("garbage")).toBeUndefined()
  })

  it("drops empty and non-string values", () => {
    expect(normalizeExpiresAt("")).toBeUndefined()
    expect(normalizeExpiresAt(undefined)).toBeUndefined()
    expect(normalizeExpiresAt(123)).toBeUndefined()
    expect(normalizeExpiresAt(new Date(NOW))).toBeUndefined()
  })
})

describe("isExpiresAtReached", () => {
  it("is false when no expiry was set", () => {
    expect(isExpiresAtReached(undefined, NOW)).toBe(false)
  })

  it("is true for the past", () => {
    expect(isExpiresAtReached("2025-12-31T23:59:59.000Z", NOW)).toBe(true)
  })

  it("is false for the future", () => {
    expect(isExpiresAtReached("2026-01-01T00:00:01.000Z", NOW)).toBe(false)
  })

  it("fails closed: an unparseable persisted value counts as expired", () => {
    expect(isExpiresAtReached("garbage", NOW)).toBe(true)
  })
})

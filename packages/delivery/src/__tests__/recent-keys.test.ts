import { describe, expect, it } from "vitest"

import { DEFAULT_RECENT_KEYS_CAP, RecentKeys, REPEAT_WINDOW_MS } from "../index.js"

describe("RecentKeys", () => {
  it("defaults: 1000 entries, 10 minute window", () => {
    expect(DEFAULT_RECENT_KEYS_CAP).toBe(1000)
    expect(REPEAT_WINDOW_MS).toBe(10 * 60 * 1000)
  })

  it("has() is false for an unseen key and scoped per target", () => {
    const recent = new RecentKeys()
    recent.record("sess_1", "k", 0)
    expect(recent.has("sess_1", "k", 1)).toBe(true)
    expect(recent.has("sess_2", "k", 1)).toBe(false)
    expect(recent.has("sess_1", "other", 1)).toBe(false)
  })

  it("a key recorded exactly at the window boundary is no longer a repeat", () => {
    const recent = new RecentKeys()
    recent.record("t", "k", 0)
    expect(recent.has("t", "k", REPEAT_WINDOW_MS - 1)).toBe(true)
    expect(recent.has("t", "k", REPEAT_WINDOW_MS)).toBe(false)
  })

  it("a clock that went backwards is not a repeat", () => {
    const recent = new RecentKeys()
    recent.record("t", "k", 100)
    expect(recent.has("t", "k", 50)).toBe(false)
  })

  it("re-recording inside the window keeps the first-seen time (fixed window)", () => {
    const recent = new RecentKeys()
    recent.record("t", "k", 0)
    recent.record("t", "k", REPEAT_WINDOW_MS - 1)
    expect(recent.has("t", "k", REPEAT_WINDOW_MS)).toBe(false)
    expect(recent.size).toBe(1)
  })

  it("re-recording after the window restarts it", () => {
    const recent = new RecentKeys()
    recent.record("t", "k", 0)
    recent.record("t", "k", REPEAT_WINDOW_MS)
    expect(recent.has("t", "k", REPEAT_WINDOW_MS + 1)).toBe(true)
  })

  it("evicts the oldest insertion past the cap", () => {
    const recent = new RecentKeys(2)
    recent.record("t", "a", 0)
    recent.record("t", "b", 1)
    recent.record("t", "c", 2)
    expect(recent.size).toBe(2)
    expect(recent.has("t", "a", 3)).toBe(false)
    expect(recent.has("t", "b", 3)).toBe(true)
    expect(recent.has("t", "c", 3)).toBe(true)
  })
})

/**
 * Unit tests for the reconnect-log rate limiter (reconnect-log-gate.ts). An
 * injectable `now` drives a fake clock so window boundaries are exercised
 * without real timers, matching the deterministic-clock idiom elsewhere.
 */

import { describe, expect, it } from "vitest"
import { createReconnectLogGate } from "../reconnect-log-gate.js"

describe("createReconnectLogGate", () => {
  it("logs the first failure immediately, verbatim", () => {
    const gate = createReconnectLogGate({ now: () => 0 })
    expect(gate.onFailure("k", "boom")).toBe("boom")
  })

  it("suppresses repeats within the window and returns null", () => {
    let t = 0
    const gate = createReconnectLogGate({ windowMs: 60_000, now: () => t })
    expect(gate.onFailure("k", "boom")).toBe("boom")
    t = 100
    expect(gate.onFailure("k", "boom")).toBeNull()
    t = 59_999
    expect(gate.onFailure("k", "boom")).toBeNull()
  })

  it("re-emits after the window with the suppressed count", () => {
    let t = 0
    const gate = createReconnectLogGate({ windowMs: 60_000, now: () => t })
    gate.onFailure("k", "boom") // logged, count resets to 0
    t = 1_000
    gate.onFailure("k", "boom") // suppressed → 1
    t = 2_000
    gate.onFailure("k", "boom") // suppressed → 2
    t = 60_001
    expect(gate.onFailure("k", "boom")).toBe("boom (2 failures suppressed)")
  })

  it("uses the singular form for exactly one suppressed failure", () => {
    let t = 0
    const gate = createReconnectLogGate({ windowMs: 60_000, now: () => t })
    gate.onFailure("k", "boom")
    t = 1_000
    gate.onFailure("k", "boom") // suppressed → 1
    t = 60_001
    expect(gate.onFailure("k", "boom")).toBe("boom (1 failure suppressed)")
  })

  it("does not re-emit a suppressed count after a clean re-emit", () => {
    let t = 0
    const gate = createReconnectLogGate({ windowMs: 60_000, now: () => t })
    gate.onFailure("k", "boom")
    t = 1_000
    gate.onFailure("k", "boom") // suppressed → 1
    t = 60_001
    expect(gate.onFailure("k", "boom")).toBe("boom (1 failure suppressed)")
    t = 60_500
    // Within the fresh window again — suppressed, count restarts from this emit.
    expect(gate.onFailure("k", "boom")).toBeNull()
    t = 130_000
    expect(gate.onFailure("k", "boom")).toBe("boom (1 failure suppressed)")
  })

  it("resets on success so the next outage logs its first failure promptly", () => {
    let t = 0
    const gate = createReconnectLogGate({ windowMs: 60_000, now: () => t })
    gate.onFailure("k", "boom")
    t = 1_000
    gate.onFailure("k", "boom") // suppressed
    gate.onSuccess("k") // clears all state for the key
    t = 1_500
    // First failure after success logs immediately, with no suppressed suffix.
    expect(gate.onFailure("k", "boom")).toBe("boom")
  })

  it("rate-limits each key independently", () => {
    let t = 0
    const gate = createReconnectLogGate({ windowMs: 60_000, now: () => t })
    expect(gate.onFailure("a", "a-boom")).toBe("a-boom")
    // A different key is on its own clock — logs its first failure at once.
    expect(gate.onFailure("b", "b-boom")).toBe("b-boom")
    t = 1_000
    expect(gate.onFailure("a", "a-boom")).toBeNull()
    expect(gate.onFailure("b", "b-boom")).toBeNull()
  })
})

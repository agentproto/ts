import { describe, it, expect } from "vitest"
import { createRateLimiter } from "./rate-limiter.js"

describe("createRateLimiter (per-IP)", () => {
  it("allows up to max per key per window, then refuses", () => {
    let t = 0
    const rl = createRateLimiter({ max: 3, windowMs: 1000, now: () => t })
    expect(rl.allow("a")).toBe(true)
    expect(rl.allow("a")).toBe(true)
    expect(rl.allow("a")).toBe(true)
    expect(rl.allow("a")).toBe(false)
  })

  it("keys are independent", () => {
    let t = 0
    const rl = createRateLimiter({ max: 1, windowMs: 1000, now: () => t })
    expect(rl.allow("a")).toBe(true)
    expect(rl.allow("b")).toBe(true)
    expect(rl.allow("a")).toBe(false)
  })

  it("window slides — old attempts expire", () => {
    let t = 0
    const rl = createRateLimiter({ max: 2, windowMs: 1000, now: () => t })
    expect(rl.allow("a")).toBe(true)
    expect(rl.allow("a")).toBe(true)
    expect(rl.allow("a")).toBe(false)
    t = 1001 // both prior attempts fall outside the window
    expect(rl.allow("a")).toBe(true)
  })

  it("caps the number of distinct keys (memory bound), sweeping drained keys first", () => {
    let t = 0
    const rl = createRateLimiter({ max: 5, windowMs: 1000, maxKeys: 2, now: () => t })
    expect(rl.allow("a")).toBe(true)
    expect(rl.allow("b")).toBe(true)
    // Map is full with two live keys; a third fresh key is refused.
    expect(rl.allow("c")).toBe(false)
    // Advance past the window so a + b drain; now a new key is admitted.
    t = 1001
    expect(rl.allow("c")).toBe(true)
  })
})

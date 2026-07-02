import { describe, expect, it } from "vitest"
import { createRateLimiter } from "./rate-limiter.js"

describe("createRateLimiter", () => {
  it("allows calls up to the max within the window", () => {
    const limiter = createRateLimiter({ max: 3, windowMs: 1000, now: () => 0 })
    expect(limiter.allow()).toBe(true)
    expect(limiter.allow()).toBe(true)
    expect(limiter.allow()).toBe(true)
    expect(limiter.allow()).toBe(false)
  })

  it("resets once the window slides past old hits", () => {
    let t = 0
    const limiter = createRateLimiter({ max: 2, windowMs: 100, now: () => t })
    expect(limiter.allow()).toBe(true)
    expect(limiter.allow()).toBe(true)
    expect(limiter.allow()).toBe(false)
    t = 101
    expect(limiter.allow()).toBe(true)
  })

  it("only expires hits that have fully aged out, not the whole window", () => {
    let t = 0
    const limiter = createRateLimiter({ max: 2, windowMs: 100, now: () => t })
    expect(limiter.allow()).toBe(true) // t=0
    t = 60
    expect(limiter.allow()).toBe(true) // t=60, both within window
    t = 105
    // t=0 hit has aged out (105-0 > 100), t=60 hit has not (105-60 <= 100)
    expect(limiter.allow()).toBe(true)
    expect(limiter.allow()).toBe(false)
  })

  it("defaults to Date.now when no clock is injected", () => {
    const limiter = createRateLimiter({ max: 1, windowMs: 1000 })
    expect(limiter.allow()).toBe(true)
    expect(limiter.allow()).toBe(false)
  })
})

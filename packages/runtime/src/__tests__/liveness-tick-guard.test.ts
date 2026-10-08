import { describe, it, expect } from "vitest"
import { createLivenessTickGuard } from "../liveness-tick-guard.js"

describe("liveness tick guard", () => {
  it("runs on-time ticks and skips a tick that fired late (loop starved)", () => {
    let t = 0
    const g = createLivenessTickGuard(30_000, 5_000, () => t)
    t = 30_000
    expect(g.shouldSkip()).toBe(false)
    t = 60_200 // 200ms jitter: fine
    expect(g.shouldSkip()).toBe(false)
    t = 150_000 // loop was blocked ~60s
    expect(g.shouldSkip()).toBe(true)
    t = 180_000 // back on schedule: judged normally again
    expect(g.shouldSkip()).toBe(false)
  })
})

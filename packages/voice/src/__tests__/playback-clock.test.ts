import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createPlaybackClock } from "../playback-clock.js"

describe("createPlaybackClock", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
  })
  afterEach(() => vi.useRealTimers())

  it("queues chunks back to back and drains in real time", () => {
    const c = createPlaybackClock()
    c.sent(500)
    c.sent(500)
    expect(c.queuedMs()).toBe(1000)
    vi.advanceTimersByTime(400)
    expect(c.queuedMs()).toBe(600)
    vi.advanceTimersByTime(5000)
    expect(c.queuedMs()).toBe(0)
    c.sent(100)
    expect(c.queuedMs()).toBe(100)
  })

  it("ignores empty or invalid chunks and resets on interrupt", () => {
    const c = createPlaybackClock()
    c.sent(0)
    c.sent(-5)
    c.sent(Number.NaN)
    expect(c.queuedMs()).toBe(0)
    c.sent(800)
    c.reset()
    expect(c.queuedMs()).toBe(0)
  })

  it("waitBelow resolves ready once the queue has drained enough", async () => {
    const c = createPlaybackClock()
    c.sent(1000)
    const p = c.waitBelow(200)
    await vi.advanceTimersByTimeAsync(800)
    await expect(p).resolves.toBe("ready")
  })

  it("waitBelow resolves ready at once when already below", async () => {
    const c = createPlaybackClock()
    c.sent(100)
    await expect(c.waitBelow(200)).resolves.toBe("ready")
  })

  it("waitBelow times out and aborts", async () => {
    const c = createPlaybackClock()
    c.sent(10_000)
    const t = c.waitBelow(0, { timeoutMs: 100 })
    await vi.advanceTimersByTimeAsync(150)
    await expect(t).resolves.toBe("timeout")

    const ac = new AbortController()
    const a = c.waitBelow(0, { signal: ac.signal })
    ac.abort()
    await expect(a).resolves.toBe("aborted")
    const pre = c.waitBelow(0, { signal: ac.signal })
    await expect(pre).resolves.toBe("aborted")
  })

  it("waitBelow resolves ready after a reset", async () => {
    const c = createPlaybackClock()
    c.sent(10_000)
    const p = c.waitBelow(0)
    c.reset()
    await vi.advanceTimersByTimeAsync(25)
    await expect(p).resolves.toBe("ready")
  })
})

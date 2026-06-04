import { describe, it, expect, vi } from "vitest"
import { ThrottleFetcher } from "../throttle-fetcher.adapter.js"
import type { FetcherPort } from "@agentproto/corpus"

function stubFetcher(): FetcherPort {
  return { fetch: vi.fn(async () => ({ title: "t", text: "x", kind: "article" as const })) }
}

describe("ThrottleFetcher", () => {
  it("does not sleep before the first fetch", async () => {
    const sleep = vi.fn(async () => {})
    const t = new ThrottleFetcher(stubFetcher(), {
      minIntervalMs: 2000,
      now: () => 1000,
      sleep,
    })
    await t.fetch("https://a.com")
    expect(sleep).not.toHaveBeenCalled()
  })

  it("sleeps the remaining interval between consecutive fetches", async () => {
    const sleep = vi.fn(async () => {})
    let t = 0
    const now = () => t
    const f = new ThrottleFetcher(stubFetcher(), { minIntervalMs: 2000, now, sleep })
    await f.fetch("https://a.com") // lastStart = 0
    t = 500 // only 500ms elapsed → must wait 1500ms more
    await f.fetch("https://b.com")
    expect(sleep).toHaveBeenCalledWith(1500)
  })

  it("does not sleep when the interval already elapsed", async () => {
    const sleep = vi.fn(async () => {})
    let t = 0
    const f = new ThrottleFetcher(stubFetcher(), { minIntervalMs: 2000, now: () => t, sleep })
    await f.fetch("https://a.com")
    t = 5000 // well past the interval
    await f.fetch("https://b.com")
    expect(sleep).not.toHaveBeenCalled()
  })

  it("minIntervalMs=0 disables throttling", async () => {
    const sleep = vi.fn(async () => {})
    const f = new ThrottleFetcher(stubFetcher(), { minIntervalMs: 0, now: () => 0, sleep })
    await f.fetch("https://a.com")
    await f.fetch("https://b.com")
    expect(sleep).not.toHaveBeenCalled()
  })
})

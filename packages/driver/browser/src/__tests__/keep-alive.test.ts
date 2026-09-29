import { describe, expect, it } from "vitest"
import { KeepAlivePolicy } from "../index.js"

function setup() {
  let t = 0
  const policy = new KeepAlivePolicy({ now: () => t, idleTabMs: 1_000, idleBrowserMs: 5_000 })
  return { policy, advance: (ms: number) => (t += ms) }
}

describe("KeepAlivePolicy", () => {
  it("reaps idle tabs but never a keepAlive session's tabs", async () => {
    const { policy, advance } = setup()
    policy.registerSession("login", { keepAlive: true })
    policy.registerSession("scrape")
    policy.trackTab("tab-login", "login")
    policy.trackTab("tab-scrape", "scrape")
    advance(10_000)

    expect(policy.reapableTabs()).toEqual(["tab-scrape"])
    const closed: string[] = []
    await policy.reap(async (id) => {
      closed.push(id)
    })
    expect(closed).toEqual(["tab-scrape"])
    expect(policy.isKeepAliveTab("tab-login")).toBe(true)

    advance(10_000)
    expect(policy.reapableTabs()).toEqual([])
  })

  it("keeps a recently touched tab", () => {
    const { policy, advance } = setup()
    policy.registerSession("s")
    policy.trackTab("t", "s")
    advance(900)
    policy.touchTab("t")
    advance(900)
    expect(policy.reapableTabs()).toEqual([])
    advance(200)
    expect(policy.reapableTabs()).toEqual(["t"])
  })

  it("blocks idle browser shutdown while any keepAlive session exists", () => {
    const { policy, advance } = setup()
    policy.registerSession("login", { keepAlive: true })
    advance(1_000_000)
    expect(policy.shouldShutdownIdleBrowser()).toEqual({ shutdown: false, reason: "keep-alive-session" })

    policy.endSession("login")
    expect(policy.shouldShutdownIdleBrowser()).toEqual({ shutdown: true })
  })

  it("refuses shutdown until the browser has been idle long enough", () => {
    const { policy, advance } = setup()
    policy.registerSession("s")
    advance(4_000)
    expect(policy.shouldShutdownIdleBrowser()).toEqual({ shutdown: false, reason: "not-idle" })
    advance(1_500)
    expect(policy.shouldShutdownIdleBrowser()).toEqual({ shutdown: true })
  })
})

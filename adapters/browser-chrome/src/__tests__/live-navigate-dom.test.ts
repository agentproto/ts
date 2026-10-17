import { afterEach, describe, expect, it } from "vitest"
import { createChromeLiveProvider } from "../index.js"
import { startFakeChrome, type FakeChrome } from "./live-fake-chrome.js"

const fakes: FakeChrome[] = []
afterEach(async () => {
  await Promise.all(fakes.splice(0).map((f) => f.close()))
})

async function fake(options?: Parameters<typeof startFakeChrome>[0]): Promise<FakeChrome> {
  const f = await startFakeChrome(options)
  fakes.push(f)
  return f
}

describe("chrome-live: navigateOwnedTarget", () => {
  it("opens a fresh owned tab when none exists yet, via attach({ initialUrl })", async () => {
    const f = await fake()
    const instance = await createChromeLiveProvider({ port: f.port, env: {} }).launch({}, {})
    const result = await instance.navigateOwnedTarget("https://example.test/one")
    expect(result.url).toBe("https://example.test/one")
    expect(f.commands.some((c) => c.method === "Target.createTarget")).toBe(true)
    expect(f.commands.some((c) => c.method === "Page.navigate")).toBe(false)
    await instance.stop()
  })

  it("reuses an existing owned tab via Page.navigate instead of opening a second one", async () => {
    const f = await fake()
    const instance = await createChromeLiveProvider({ port: f.port, env: {} }).launch({}, {})
    const first = await instance.navigateOwnedTarget("https://example.test/one")
    const second = await instance.navigateOwnedTarget("https://example.test/two")
    expect(second.targetId).toBe(first.targetId)
    expect(second.url).toBe("https://example.test/two")
    expect(f.commands.filter((c) => c.method === "Target.createTarget")).toHaveLength(1)
    expect(f.commands.filter((c) => c.method === "Page.navigate")).toHaveLength(1)
    await instance.stop()
  })

  it("navigating a named tabId that isn't owned is refused", async () => {
    const f = await fake()
    const instance = await createChromeLiveProvider({ port: f.port, env: {} }).launch({}, {})
    await expect(instance.navigateOwnedTarget("https://example.test/one", "user-tab-1")).rejects.toThrow(/not owned/)
    await instance.stop()
  })
})

describe("chrome-live: domOwnedTarget", () => {
  it("throws when no agent-owned tab is open yet (same rule as screenshotOwnedTarget)", async () => {
    const f = await fake()
    const instance = await createChromeLiveProvider({ port: f.port, env: {} }).launch({}, {})
    await expect(instance.domOwnedTarget()).rejects.toThrow(/no agent-owned tab/)
    await instance.stop()
  })

  it("serializes the owned tab's DOM after navigateOwnedTarget", async () => {
    const f = await fake({ domHtml: "<html><body><h1>Hello</h1></body></html>" })
    const instance = await createChromeLiveProvider({ port: f.port, env: {} }).launch({}, {})
    const nav = await instance.navigateOwnedTarget("https://example.test/one")
    const dom = await instance.domOwnedTarget()
    expect(dom.targetId).toBe(nav.targetId)
    expect(dom.url).toBe("https://example.test/one")
    expect(dom.html).toContain("<h1>Hello</h1>")
    await instance.stop()
  })

  it("rejects a foreign tabId, same ownership guard as screenshotOwnedTarget", async () => {
    const f = await fake()
    const instance = await createChromeLiveProvider({ port: f.port, env: {} }).launch({}, {})
    await instance.navigateOwnedTarget("https://example.test/one")
    await expect(instance.domOwnedTarget("user-tab-1")).rejects.toThrow(/not owned/)
    await instance.stop()
  })
})

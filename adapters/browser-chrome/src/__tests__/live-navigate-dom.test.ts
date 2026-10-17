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

  it("returns the COMMITTED url (document.location.href), not the requested one, when a redirect moves it", async () => {
    const f = await fake({ locationHref: "https://example.test/one/canonical" })
    const instance = await createChromeLiveProvider({ port: f.port, env: {} }).launch({}, {})
    const result = await instance.navigateOwnedTarget("https://example.test/one")
    expect(result.url).toBe("https://example.test/one/canonical")
    await instance.stop()
  })

  it("falls back to the requested url when reading document.location.href fails (best-effort, never fails the navigation)", async () => {
    const f = await fake()
    const instance = await createChromeLiveProvider({ port: f.port, env: {} }).launch({}, {})
    const result = await instance.navigateOwnedTarget("https://example.test/one")
    expect(result.url).toBe("https://example.test/one")
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

describe("chrome-live: clickOwnedTarget", () => {
  it("dispatches trusted mouse events at the selector's center", async () => {
    const f = await fake()
    const instance = await createChromeLiveProvider({ port: f.port, env: {} }).launch({}, {})
    await instance.navigateOwnedTarget("https://example.test/one")
    await instance.clickOwnedTarget({ selector: "#go", button: "left", clickCount: 1, trusted: true })
    const moved = f.commands.filter((c) => c.method === "Input.dispatchMouseEvent")
    expect(moved).toHaveLength(3) // mouseMoved, mousePressed, mouseReleased
    await instance.stop()
  })

  it("throws when the selector matches nothing", async () => {
    const f = await fake({ selectorMissing: true })
    const instance = await createChromeLiveProvider({ port: f.port, env: {} }).launch({}, {})
    await instance.navigateOwnedTarget("https://example.test/one")
    await expect(
      instance.clickOwnedTarget({ selector: "#missing", button: "left", clickCount: 1, trusted: true })
    ).rejects.toThrow(/no element matches/)
    await instance.stop()
  })

  it("throws when no agent-owned tab is open yet (same rule as screenshotOwnedTarget)", async () => {
    const f = await fake()
    const instance = await createChromeLiveProvider({ port: f.port, env: {} }).launch({}, {})
    await expect(
      instance.clickOwnedTarget({ selector: "#go", button: "left", clickCount: 1, trusted: true })
    ).rejects.toThrow(/no agent-owned tab/)
    await instance.stop()
  })
})

describe("chrome-live: fillOwnedTarget", () => {
  it("focuses the selector and inserts the value", async () => {
    const f = await fake()
    const instance = await createChromeLiveProvider({ port: f.port, env: {} }).launch({}, {})
    await instance.navigateOwnedTarget("https://example.test/one")
    await instance.fillOwnedTarget({ selector: "#q", value: "hello", clear: true })
    expect(f.commands.some((c) => c.method === "Input.insertText" && c.params?.text === "hello")).toBe(true)
    await instance.stop()
  })

  it("throws when the selector matches nothing", async () => {
    const f = await fake({ selectorMissing: true })
    const instance = await createChromeLiveProvider({ port: f.port, env: {} }).launch({}, {})
    await instance.navigateOwnedTarget("https://example.test/one")
    await expect(instance.fillOwnedTarget({ selector: "#missing", value: "x", clear: true })).rejects.toThrow(
      /no element matches/
    )
    await instance.stop()
  })
})

describe("chrome-live: evaluateOwnedTarget", () => {
  it("evaluates a JS expression on the owned tab and returns its value", async () => {
    const f = await fake({ domTitle: "Piece" })
    const instance = await createChromeLiveProvider({ port: f.port, env: {} }).launch({}, {})
    await instance.navigateOwnedTarget("https://example.test/one")
    const result = await instance.evaluateOwnedTarget<string>({
      expression: "document.title",
      awaitPromise: false,
      returnByValue: true,
      maxResultBytes: 1_000,
    })
    expect(result.value).toBe("Piece")
    await instance.stop()
  })

  it("throws when no agent-owned tab is open yet", async () => {
    const f = await fake()
    const instance = await createChromeLiveProvider({ port: f.port, env: {} }).launch({}, {})
    await expect(
      instance.evaluateOwnedTarget({ expression: "1", awaitPromise: false, returnByValue: true, maxResultBytes: 1_000 })
    ).rejects.toThrow(/no agent-owned tab/)
    await instance.stop()
  })
})

describe("chrome-live: scrollOwnedTarget", () => {
  it("scrolls a selector into view", async () => {
    const f = await fake()
    const instance = await createChromeLiveProvider({ port: f.port, env: {} }).launch({}, {})
    const nav = await instance.navigateOwnedTarget("https://example.test/one")
    const result = await instance.scrollOwnedTarget({ selector: "#bottom" })
    expect(result.targetId).toBe(nav.targetId)
    await instance.stop()
  })

  it("throws when the selector matches nothing", async () => {
    const f = await fake({ selectorMissing: true })
    const instance = await createChromeLiveProvider({ port: f.port, env: {} }).launch({}, {})
    await instance.navigateOwnedTarget("https://example.test/one")
    await expect(instance.scrollOwnedTarget({ selector: "#missing" })).rejects.toThrow(/no element matches/)
    await instance.stop()
  })

  it("scrolls the window to an absolute x/y without needing a selector", async () => {
    const f = await fake()
    const instance = await createChromeLiveProvider({ port: f.port, env: {} }).launch({}, {})
    await instance.navigateOwnedTarget("https://example.test/one")
    await expect(instance.scrollOwnedTarget({ x: 0, y: 500 })).resolves.toMatchObject({})
    await instance.stop()
  })
})

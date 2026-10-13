import { createServer } from "node:net"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { ToolError } from "@agentproto/tool"
import {
  BROWSER_CONSENT_TIMEOUT_CODE,
  BROWSER_DISCONNECTED_CODE,
  BROWSER_REMOTE_DEBUGGING_OFF_CODE,
  chromeLive,
  createChromeLiveProvider,
  readChromeLiveEnv,
  type ChromeLiveProviderConfig,
} from "../index.js"
import { startFakeChrome, type FakeChrome, type FakeChromeOptions } from "./live-fake-chrome.js"

const fakes: FakeChrome[] = []
afterEach(async () => {
  await Promise.all(fakes.splice(0).map((f) => f.close()))
})

async function fake(options?: FakeChromeOptions): Promise<FakeChrome> {
  const f = await startFakeChrome(options)
  fakes.push(f)
  return f
}

function provider(f: FakeChrome, extra: ChromeLiveProviderConfig = {}) {
  return createChromeLiveProvider({ port: f.port, env: {}, consentTimeoutMs: 2_000, ...extra })
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (err) {
    expect(err).toBeInstanceOf(ToolError)
    return (err as ToolError).code
  }
  throw new Error("expected a rejection")
}

async function closedPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

const newWindowCalls = (f: FakeChrome) => f.commands.filter((c) => c.method === "Target.createTarget" && c.params?.newWindow === true)
const methods = (f: FakeChrome) => f.commands.map((c) => c.method)
const until = async (cond: () => boolean): Promise<void> => {
  for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 10))
}

describe("chrome-live: attach to the user's running Chrome", () => {
  it("connects once, opens its own window with newWindow:true, and evaluates in its own flat session", async () => {
    const f = await fake()
    const lines: string[] = []
    const instance = await provider(f).launch({}, { log: (l) => void lines.push(l) })
    expect(instance.wasAlreadyRunning).toBe(false)
    expect(instance.endpoints.cdp).toBe(f.wsUrl)
    expect(instance.pid).toBeUndefined()
    expect(methods(f)[0]).toBe("Browser.getVersion")
    expect(lines.join("\n")).toMatch(/click "Allow"/)

    const driver = await instance.attach({ initialUrl: "https://mail.example/inbox" })
    const create = f.commands.find((c) => c.method === "Target.createTarget")
    expect(create?.params).toEqual({ url: "https://mail.example/inbox", newWindow: true })
    expect(f.commands.find((c) => c.method === "Target.attachToTarget")?.params).toEqual({ targetId: driver.target.id, flatten: true })
    expect(driver.kind).toBe("chrome-live")
    expect(driver.capabilities).toMatchObject({ isUserVisible: true, canMultiTarget: true })
    expect(driver.target.url).toBe("https://mail.example/inbox")

    const webdriver = await driver.evaluate<boolean>({ expression: "navigator.webdriver", awaitPromise: false, returnByValue: true, maxResultBytes: 100 })
    expect(webdriver.value).toBe(false)
    const evaluate = f.commands.find((c) => c.method === "Runtime.evaluate")
    expect(evaluate?.sessionId).toBe(`session-${driver.target.id}`)
    expect(f.connections).toBe(1)
    expect(f.violations).toEqual([])
    await instance.stop()
  })

  it("opens further tabs in the agent window, never a second newWindow:true", async () => {
    const f = await fake()
    const instance = await provider(f).launch({}, {})
    const first = await instance.attach({ initialUrl: "https://a.example/" })
    const second = await instance.attach({ initialUrl: "https://b.example/" })
    const third = await instance.attach()
    expect(newWindowCalls(f)).toHaveLength(1)
    const agentWindow = f.targets.get(first.target.id)?.windowId
    expect(agentWindow).toBeGreaterThanOrEqual(100)
    expect(f.targets.get(second.target.id)?.windowId).toBe(agentWindow)
    expect(f.targets.get(third.target.id)?.windowId).toBe(agentWindow)
    for (const t of f.userTargets) expect(f.targets.get(t)?.windowId).toBe(1)
    // Each extra tab focuses one of OUR tabs first so Chrome puts it in the agent window.
    const activations = f.commands.filter((c) => c.method === "Target.activateTarget")
    expect(activations).toHaveLength(2)
    expect(activations.every((c) => c.params?.targetId === first.target.id)).toBe(true)
    expect(f.violations).toEqual([])
    await instance.stop()
  })

  it("reuses the agent window across repeated launch().then(attach), as Bureau does", async () => {
    const f = await fake()
    const p = provider(f)
    const owner = await p.launch({}, {})
    await owner.attach()
    for (let i = 0; i < 3; i++) await (await p.launch({}, {})).attach()
    expect(f.connections).toBe(1)
    expect(newWindowCalls(f)).toHaveLength(1)
    await owner.stop()
  })

  it("concurrent launches share one connection (the in-flight connect is memoized)", async () => {
    const f = await fake()
    const p = provider(f)
    const all = await Promise.all([p.launch({}, {}), p.launch({}, {}), p.launch({}, {})])
    expect(f.connections).toBe(1)
    expect(all.filter((i) => !i.wasAlreadyRunning)).toHaveLength(1)
    expect(new Set(all.map((i) => i.id)).size).toBe(1)
    // Concurrent attaches on a fresh connection still open exactly one window.
    await Promise.all(all.map((i) => i.attach()))
    expect(newWindowCalls(f)).toHaveLength(1)
    await all.find((i) => !i.wasAlreadyRunning)?.stop()
  })

  it("health checks reuse the existing connection", async () => {
    const f = await fake()
    const instance = await provider(f).launch({}, {})
    for (let i = 0; i < 3; i++) expect((await instance.health()).ok).toBe(true)
    expect(f.connections).toBe(1)
    await instance.stop()
    expect((await instance.health()).ok).toBe(false)
    expect(f.connections).toBe(1)
  })

  it("stop() closes only the targets it created and never sends Browser.close", async () => {
    const f = await fake()
    const instance = await provider(f).launch({}, {})
    const a = await instance.attach({ initialUrl: "https://a.example/" })
    const b = await instance.attach({ initialUrl: "https://b.example/" })
    await instance.stop()
    await instance.stop()
    const closed = f.commands.filter((c) => c.method === "Target.closeTarget").map((c) => c.params?.targetId)
    expect(new Set(closed)).toEqual(new Set([a.target.id, b.target.id]))
    expect(methods(f)).not.toContain("Browser.close")
    expect(methods(f)).not.toContain("Target.getTargets")
    for (const t of f.userTargets) expect(f.targets.has(t)).toBe(true)
    expect([...f.targets.values()].filter((t) => t.created)).toEqual([])
    expect(f.violations).toEqual([])
    await expect(instance.attach()).rejects.toThrow(/stopped/)
  })

  it("a reused handle's stop() closes only its own tabs and keeps the connection", async () => {
    const f = await fake()
    const p = provider(f)
    const owner = await p.launch({}, {})
    const ownerTab = await owner.attach()
    const reused = await p.launch({}, {})
    const reusedTab = await reused.attach()
    await reused.stop()
    expect(f.targets.has(reusedTab.target.id)).toBe(false)
    expect(f.targets.has(ownerTab.target.id)).toBe(true)
    expect((await owner.health()).ok).toBe(true)
    await owner.stop()
    expect(f.targets.has(ownerTab.target.id)).toBe(false)
  })

  it("refuses Target.*, Browser.* and cookie writes from the agent, and never forwards them", async () => {
    const f = await fake()
    const instance = await provider(f).launch({}, {})
    const driver = await instance.attach()
    const before = f.commands.length
    for (const method of ["Target.getTargets", "Target.attachToTarget", "Browser.close", "Network.setCookies", "Storage.clearCookies"]) {
      expect(await codeOf(driver.send({ method, params: { targetId: "user-tab-1" } }))).toBe("unauthorised")
    }
    expect(f.commands.length).toBe(before)
    // Reading stays possible.
    await driver.send({ method: "Network.getCookies" })
    expect(f.commands.at(-1)?.method).toBe("Network.getCookies")
    expect(f.violations).toEqual([])
    await instance.stop()
  })

  it("closes a tab that landed outside the agent window instead of leaving it among the user's tabs", async () => {
    const f = await fake()
    const instance = await provider(f).launch({}, {})
    await instance.attach()
    f.options.stealFocus = true
    await expect(instance.attach()).rejects.toThrow(/outside the agent window/)
    expect(newWindowCalls(f)).toHaveLength(1)
    expect([...f.targets.values()].filter((t) => t.created && t.windowId === 1)).toEqual([])
    await instance.stop()
  })

  it("opens a new window only once the user closed the agent window", async () => {
    const f = await fake()
    const instance = await provider(f).launch({}, {})
    const first = await instance.attach()
    await first.close()
    await instance.attach()
    expect(newWindowCalls(f)).toHaveLength(2)
    await instance.stop()
  })
})

describe("chrome-live: typed errors", () => {
  it("port closed -> browser:remote-debugging-off, pointing at chrome://inspect", async () => {
    const port = await closedPort()
    const p = createChromeLiveProvider({ port, env: {} })
    const err = await p.launch({}, {}).then(
      () => {
        throw new Error("expected a rejection")
      },
      (e: unknown) => e as ToolError,
    )
    expect(err.code).toBe(BROWSER_REMOTE_DEBUGGING_OFF_CODE)
    expect(err.message).toContain("Enable remote debugging at chrome://inspect/#remote-debugging")
    // Without discovery the websocket itself reports the closed port the same way.
    expect(await codeOf(createChromeLiveProvider({ port, env: {}, discover: false }).launch({}, {}))).toBe(BROWSER_REMOTE_DEBUGGING_OFF_CODE)
  })

  it("no Allow click within consentTimeoutMs -> browser:consent-timeout", async () => {
    const f = await fake({ consent: "hold" })
    const started = Date.now()
    expect(await codeOf(provider(f, { consentTimeoutMs: 300 }).launch({}, {}))).toBe(BROWSER_CONSENT_TIMEOUT_CODE)
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it("an opened socket that never answers is a consent timeout too", async () => {
    const f = await fake({ consent: "silent" })
    expect(await codeOf(provider(f, { consentTimeoutMs: 300 }).launch({}, {}))).toBe(BROWSER_CONSENT_TIMEOUT_CODE)
  })

  it("a rejected connection -> browser:consent-timeout, and the next launch tries again", async () => {
    const f = await fake({ consent: "reject" })
    const p = provider(f)
    expect(await codeOf(p.launch({}, {}))).toBe(BROWSER_CONSENT_TIMEOUT_CODE)
    f.options.consent = "allow"
    const instance = await p.launch({}, {})
    expect((await instance.health()).ok).toBe(true)
    await instance.stop()
  })

  it("a dropped connection -> browser:disconnected; the next launch reconnects (consent again) and still owns its tabs", async () => {
    const f = await fake()
    const lines: string[] = []
    const p = provider(f)
    const ctx = { log: (l: string) => void lines.push(l) }
    const instance = await p.launch({}, ctx)
    const driver = await instance.attach({ initialUrl: "https://a.example/" })
    f.dropAll()
    await until(() => lines.some((l) => l.includes("lost the connection")))
    expect(lines.join("\n")).toMatch(/Chrome will ask for consent again/)
    expect(await codeOf(driver.evaluate({ expression: "1", awaitPromise: false, returnByValue: true, maxResultBytes: 10 }))).toBe(BROWSER_DISCONNECTED_CODE)
    expect(await codeOf(instance.attach())).toBe(BROWSER_DISCONNECTED_CODE)
    expect((await instance.health()).ok).toBe(false)
    expect(f.connections).toBe(1)

    const again = await p.launch({}, ctx)
    expect(again.wasAlreadyRunning).toBe(false)
    expect(f.connections).toBe(2)
    expect(lines.filter((l) => l.includes("reconnecting")).length).toBe(1)
    // The tab from before the drop is reused as the agent window, then closed by stop().
    await again.attach()
    expect(newWindowCalls(f)).toHaveLength(1)
    await again.stop()
    expect(f.targets.has(driver.target.id)).toBe(false)
    expect(methods(f)).not.toContain("Browser.close")
    expect(f.violations).toEqual([])
  })
})

describe("chrome-live: config", () => {
  it("reads CHROME_LIVE_PORT and CHROME_LIVE_WS_URL, treating blank as unset", () => {
    expect(readChromeLiveEnv({ CHROME_LIVE_PORT: "9333" })).toEqual({ port: 9333 })
    expect(readChromeLiveEnv({ CHROME_LIVE_PORT: "", CHROME_LIVE_WS_URL: " " })).toEqual({})
    expect(readChromeLiveEnv({ CHROME_LIVE_WS_URL: "ws://10.0.0.2:9222/devtools/browser" })).toEqual({ wsUrl: "ws://10.0.0.2:9222/devtools/browser" })
    expect(() => readChromeLiveEnv({ CHROME_LIVE_PORT: "nope" })).toThrow(/CHROME_LIVE_PORT/)
    expect(() => readChromeLiveEnv({ CHROME_LIVE_WS_URL: "http://x" })).toThrow(/CHROME_LIVE_WS_URL/)
  })

  it("uses CHROME_LIVE_PORT from the env and CHROME_LIVE_WS_URL over it", async () => {
    const f = await fake()
    const byPort = await createChromeLiveProvider({ env: { CHROME_LIVE_PORT: String(f.port) } }).launch({}, {})
    expect(byPort.endpoints.cdp).toBe(f.wsUrl)
    await byPort.stop()
    const byUrl = await createChromeLiveProvider({ env: { CHROME_LIVE_PORT: "1", CHROME_LIVE_WS_URL: f.wsUrl } }).launch({}, {})
    expect(byUrl.endpoints.cdp).toBe(f.wsUrl)
    await byUrl.stop()
    // An explicit launch port beats anything from the env.
    const byLaunch = await createChromeLiveProvider({ env: { CHROME_LIVE_WS_URL: "ws://127.0.0.1:1/devtools/browser" } }).launch({ port: f.port }, {})
    expect(byLaunch.endpoints.cdp).toBe(f.wsUrl)
    await byLaunch.stop()
  })

  it("check() probes the port without opening a websocket", async () => {
    const f = await fake()
    expect(await provider(f).check?.()).toBe(true)
    expect(f.connections).toBe(0)
    expect(await createChromeLiveProvider({ port: await closedPort(), env: {} }).check?.()).toBe(false)
  })

  it("declares cdp, a visible multi-tab window, and no headless / persistentProfile / cookie-write capability", () => {
    expect(chromeLive.id).toBe("chrome-live")
    expect(chromeLive.location).toBe("local")
    expect(chromeLive.capabilities).toMatchObject({
      cdp: true,
      isUserVisible: true,
      canMultiTarget: true,
      headless: false,
      persistentProfile: false,
      canCookies: false,
    })
    expect(chromeLive.config.map((c) => c.persist?.env)).toEqual(["CHROME_LIVE_PORT", "CHROME_LIVE_WS_URL"])
  })
})

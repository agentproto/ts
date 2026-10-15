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
  type ChromeLiveDriver,
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
const createTargetNewWindowCount = (f: FakeChrome) => newWindowCalls(f).length
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

    const driver = (await instance.attach({ initialUrl: "https://mail.example/inbox" })) as ChromeLiveDriver
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

  it("captures only an active provider-owned target over its memoized connection", async () => {
    const f = await fake()
    const instance = await provider(f).launch({}, {})
    await expect(instance.screenshotOwnedTarget()).rejects.toThrow(/no agent-owned tab/)
    const driver = await instance.attach()
    await expect(instance.screenshotOwnedTarget("user-tab-1")).rejects.toThrow(/not owned/)
    expect(await instance.screenshotOwnedTarget(driver.target.id)).toEqual({ base64: "AAAA", format: "png", width: 1, height: 1 })
    expect(f.connections).toBe(1)
    expect(f.httpRequests).toBe(0)
    expect(f.violations).toEqual([])
    await instance.stop()
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
    // With the opt-in discovery, the HTTP probe reports the closed port the same way.
    expect(await codeOf(createChromeLiveProvider({ port, env: {}, discover: true }).launch({}, {}))).toBe(BROWSER_REMOTE_DEBUGGING_OFF_CODE)
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
  it("connects straight to the fixed browser URL by default, with no /json/* request", async () => {
    const f = await fake()
    const instance = await provider(f).launch({}, {})
    expect(instance.endpoints.cdp).toBe(`ws://127.0.0.1:${f.port}/devtools/browser`)
    expect(f.httpRequests).toBe(0)
    expect(f.connections).toBe(1)
    await instance.stop()
  })

  it("discover: true is opt-in: one /json/version probe, then the fixed URL when it answers empty", async () => {
    const f = await fake()
    const p = provider(f, { discover: true })
    const instance = await p.launch({}, {})
    expect(f.httpRequests).toBe(1)
    expect(instance.endpoints.cdp).toBe(f.wsUrl)
    await p.launch({}, {})
    expect(f.httpRequests).toBe(1)
    expect(f.connections).toBe(1)
    await instance.stop()
  })

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

describe("chrome-live: screencast of the agent's own tab", () => {
  it("exposes the screencast capability and only chrome-live declares it", async () => {
    const f = await fake()
    const instance = await provider(f).launch({}, { log: () => undefined })
    const driver = await instance.attach()
    expect(driver.capabilities.canScreencast).toBe(true)
    await instance.stop()
  })

  it("driver lifecycle: start → frame → ack → stop, all on the driver's own flat session", async () => {
    const f = await fake()
    const instance = await provider(f).launch({}, { log: () => undefined })
    const driver = (await instance.attach({ initialUrl: "https://mail.example/inbox" })) as ChromeLiveDriver
    const cdpSession = `session-${driver.target.id}`

    await driver.startScreencast({ everyNthFrame: 1, quality: 80 })
    expect(f.screencastActive(cdpSession)).toBe(true)
    const start = f.commands.find(c => c.method === "Page.startScreencast")
    expect(start?.sessionId).toBe(cdpSession)
    expect(start?.params).toMatchObject({ format: "jpeg", quality: 80, everyNthFrame: 1 })
    // Ownership guard untouched — screencast rides Page.* only.
    await expect(driver.send({ method: "Network.setCookies", params: { cookies: [] } })).rejects.toThrow(/refused/)

    f.emitScreencastFrame(cdpSession, { data: "AAAA", sessionId: "frame-1" })
    f.emitScreencastFrame(cdpSession, { data: "BBBB", sessionId: "frame-2" })
    await until(() => driver.getScreencastFrames().frames.length >= 2)
    const frame = driver.getScreencastFrame()
    expect(frame?.data).toBe("BBBB")
    expect(frame?.format).toBe("jpeg")
    expect(frame?.width).toBeUndefined()
    await until(() => f.acknowledgments.length >= 2)
    expect(f.acknowledgments.map(a => a.params.sessionId).sort()).toEqual(["frame-1", "frame-2"])

    const stopped = await driver.stopScreencast()
    expect(stopped.frameCount).toBe(2)
    expect(stopped.total).toBe(2)
    expect(f.screencastActive(cdpSession)).toBe(false)
    expect(methods(f).includes("Page.stopScreencast")).toBe(true)
    // No screencast activity outside the agent's session:
    expect(f.violations).toEqual([])
    await instance.stop()
  })
})

describe("chrome-live: instance-level screencast across reused handles", () => {
  it("instance.screencastStart attaches its own driver, frame/stop see the frames, and a re-launch (wasAlreadyRunning) reaches the same running entry", async () => {
    const f = await fake()
    // One provider instance owns the module-level entries map (the
    // "ws://127.0.0.1:<port>/devtools/browser" → entry singleton) — a second
    // `start_browser` in the real world goes through the SAME provider.
    const config = provider(f)
    const first = await config.launch({}, { log: () => undefined })
    expect(first.wasAlreadyRunning).toBe(false)

    const ownershipTargetsBefore = createTargetNewWindowCount(f)
    const started = await first.screencastStart({ everyNthFrame: 1 })
    expect(started.targetId).toBeDefined()
    // No pre-existing agent driver: screencastStart opened an owned tab.
    expect(createTargetNewWindowCount(f)).toBe(ownershipTargetsBefore + 1)
    const cdpSession = `session-${started.targetId}`
    expect(f.screencastActive(cdpSession)).toBe(true)

    f.emitScreencastFrame(cdpSession, { data: "AAAA", sessionId: "frame-1" })
    f.emitScreencastFrame(cdpSession, { data: "CCCC", sessionId: "frame-2", deviceWidth: 64, deviceHeight: 32 })
    const untilAsync = async (cond: () => Promise<boolean>): Promise<void> => {
      for (let i = 0; i < 100; i++) {
        if (await cond()) return
        await new Promise((r) => setTimeout(r, 10))
      }
    }
    await untilAsync(async () => (await first.screencastFrame())?.data === "CCCC")
    const latest = await first.screencastFrame()
    expect(latest?.width).toBe(64)
    expect(latest?.height).toBe(32)

    // A second instance handle (the real-world `wasAlreadyRunning: true`
    // second start_browser — a fresh makeInstance on the same entry) still
    // reaches the same screencast: the pointer lives on the entry, not on
    // any single instance handle.
    const second = await config.launch({}, { log: () => undefined })
    expect(second.wasAlreadyRunning).toBe(true)
    expect((await second.screencastFrame())?.data).toBe("CCCC")
    const stopped = await second.screencastStop()
    expect(stopped.targetId).toBe(started.targetId)
    expect(stopped.frameCount).toBe(2)
    expect(stopped.frames.map(fr => fr.data)).toEqual(["AAAA", "CCCC"])
    expect(f.screencastActive(cdpSession)).toBe(false)
  })
})

describe("chrome-live: screencast restart-after-stop", () => {
  it("attaches a fresh flat session per start (same owned target), so stop -> start keeps delivering frames", async () => {
    const f = await fake()
    const instance = await provider(f).launch({}, { log: () => undefined })
    const started1 = await instance.screencastStart({ everyNthFrame: 1 })
    const cdpSession = `session-${started1.targetId}`
    f.emitScreencastFrame(cdpSession, { data: "AAAA", sessionId: "frame-1" })
    await until(() => f.acknowledgments.length >= 1)
    const stopped = await instance.screencastStop()
    expect(stopped.frameCount).toBe(1)

    const attachCallsBeforeRestart = f.commands.filter(
      c => c.method === "Target.attachToTarget" && c.params?.targetId === started1.targetId,
    ).length
    const started2 = await instance.screencastStart({ everyNthFrame: 1 })
    expect(started2.targetId).toBe(started1.targetId)
    const attachCalls = f.commands.filter(
      c => c.method === "Target.attachToTarget" && c.params?.targetId === started1.targetId,
    )
    expect(attachCalls.length).toBe(attachCallsBeforeRestart + 1)
    // Detached the previous cast session first (fresh-session rule).
    expect(methods(f).includes("Target.detachFromTarget")).toBe(true)
    // New flat session id differs from the driver's control session.
    expect(started2.targetId).toBeDefined()
    const castSession = `session-${started2.targetId}`
    f.emitScreencastFrame(castSession, { data: "BBBB", sessionId: "frame-2" })
    f.emitScreencastFrame(castSession, { data: "CCCC", sessionId: "frame-3" })
    const untilAsync = async (cond: () => Promise<boolean>): Promise<void> => {
      for (let i = 0; i < 100; i++) {
        if (await cond()) return
        await new Promise((r) => setTimeout(r, 10))
      }
    }
    await untilAsync(async () => (await instance.screencastFrame())?.data === "CCCC")
    const stopped2 = await instance.screencastStop()
    expect(stopped2.frameCount).toBe(2)
    expect(stopped2.frames.map((fr) => fr.data)).toEqual(["BBBB", "CCCC"])
    await instance.stop()
  })
})

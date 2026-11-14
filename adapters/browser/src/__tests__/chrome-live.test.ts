import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it, vi } from "vitest"
import { WebSocketServer } from "ws"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BROWSER_REMOTE_DEBUGGING_OFF_CODE, CHROME_LIVE_DEFAULT_PORT, chromeLive } from "@agentproto/adapter-browser-chrome"
import { browserAdapters, getBrowserAdapter } from "../index.js"
import { chromeLiveLaunchOptionsFrom, chromeLiveProvider, createChromeLiveAdapter } from "../adapters/chrome-live.js"

const servers: Server[] = []
const tmpHomes: string[] = []
const AGENTPROTO_HOME_ENV = "AGENTPROTO_HOME"
const originalHome = process.env[AGENTPROTO_HOME_ENV]

afterEach(async () => {
  for (const h of tmpHomes.splice(0)) rmSync(h, { recursive: true, force: true })
  if (originalHome === undefined) delete process.env[AGENTPROTO_HOME_ENV]
  else process.env[AGENTPROTO_HOME_ENV] = originalHome
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          s.closeAllConnections()
          s.close(() => resolve())
        }),
    ),
  )
})

/** A temp AGENTPROTO_HOME with a written chrome-live install ledger. */
function tempHomeWithLedger(envValues: Record<string, string>): string {
  const home = mkdtempSync(join(tmpdir(), "chrome-live-ledger-"))
  tmpHomes.push(home)
  mkdirSync(join(home, "browser-adapters"), { recursive: true })
  writeFileSync(
    join(home, "browser-adapters", "chrome-live.json"),
    JSON.stringify({ slug: "browser-adapter:chrome-live", updatedAt: new Date().toISOString(), steps: {}, envValues }),
  )
  process.env[AGENTPROTO_HOME_ENV] = home
  return home
}

/** A Chrome with the remote debugging toggle on: empty HTTP, one id-less browser websocket. */
async function toggleChrome(): Promise<{ port: number; methods: string[]; connections: () => number }> {
  const server = createServer((_req, res) => void res.writeHead(200).end())
  servers.push(server)
  const wss = new WebSocketServer({ server, path: "/devtools/browser" })
  const methods: string[] = []
  let connections = 0
  wss.on("connection", (ws) => {
    connections++
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as { id: number; method: string }
      methods.push(msg.method)
      ws.send(JSON.stringify({ id: msg.id, result: msg.method === "Browser.getVersion" ? { product: "Chrome/155" } : {} }))
    })
  })
  server.once("close", () => {
    for (const ws of wss.clients) ws.terminate()
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  return { port: (server.address() as AddressInfo).port, methods, connections: () => connections }
}

async function closedPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

describe("chrome-live facade", () => {
  it("is registered next to camofox, bureau and chromium and backed by the kit provider", () => {
    expect(Object.keys(browserAdapters)).toContain("chrome-live")
    const handle = getBrowserAdapter("chrome-live")!
    expect(handle.id).toBe("chrome-live")
    expect(handle.location).toBe("local")
    expect(handle.defaultPort).toBe(9222)
    expect(chromeLiveProvider).toBe(chromeLive)
    expect(chromeLiveProvider.capabilities).toMatchObject({ cdp: true, headless: false, persistentProfile: false })
  })

  it("ensure's instance exposes navigate/getDom/click/fill/evaluate/scroll, wired to the provider's owned-target methods", async () => {
    const chrome = await toggleChrome()
    const handle = getBrowserAdapter("chrome-live")!
    const instance = await handle.ensure({ port: chrome.port, env: {} })
    expect(typeof instance.navigate).toBe("function")
    expect(typeof instance.getDom).toBe("function")
    expect(typeof instance.click).toBe("function")
    expect(typeof instance.fill).toBe("function")
    expect(typeof instance.evaluate).toBe("function")
    expect(typeof instance.scroll).toBe("function")
    // Upload + multi-tab: the runtime's browser_upload_file / browser_new_tab /
    // browser_list_tabs tools look these THREE names up structurally — if the
    // facade forgets to forward one, that tool is dead against a real daemon.
    expect(typeof instance.uploadFileOntoFileInput).toBe("function")
    expect(typeof instance.openNewTab).toBe("function")
    expect(typeof instance.listOwnedTabs).toBe("function")
    await instance.stop()
  })

  it("ensure attaches to a running toggle-mode Chrome, reuses the one connection, and stop never closes Chrome", async () => {
    const chrome = await toggleChrome()
    const handle = getBrowserAdapter("chrome-live")!
    const first = await handle.ensure({ port: chrome.port, env: {} })
    expect(first).toMatchObject({ id: "chrome-live", port: chrome.port, baseUrl: `http://127.0.0.1:${chrome.port}`, wasAlreadyRunning: false, healthy: true })
    expect(first.pid).toBeUndefined()
    const second = await handle.ensure({ port: chrome.port, env: {} })
    expect(second.wasAlreadyRunning).toBe(true)
    expect(chrome.connections()).toBe(1)
    await second.stop()
    await first.stop()
    expect(chrome.methods).not.toContain("Browser.close")
    expect(chrome.methods.every((m) => m === "Browser.getVersion")).toBe(true)
  })

  it("ensure honors the persisted install ledger: a port + empty ws-url attaches without an explicit port", async () => {
    const chrome = await toggleChrome()
    tempHomeWithLedger({ CHROME_LIVE_PORT: String(chrome.port), CHROME_LIVE_WS_URL: "" })
    const handle = getBrowserAdapter("chrome-live")!
    const instance = await handle.ensure({ env: {} })
    expect(instance).toMatchObject({ id: "chrome-live", port: chrome.port, wasAlreadyRunning: false, healthy: true })
    await instance.stop()
  })

  it("a ledger port equal to the step's declared default stays fallback-only: a bare ensure still launches a DEDICATED Chrome", async () => {
    const chrome = await toggleChrome()
    // An accepted-not-typed default (e.g. a ledger written before the CLI
    // stopped persisting defaults) must not pin an endpoint and flip
    // `browser start chrome-live` from dedicated-first to attach-first.
    tempHomeWithLedger({ CHROME_LIVE_PORT: String(CHROME_LIVE_DEFAULT_PORT), CHROME_LIVE_WS_URL: "" })
    const dataDir = mkdtempSync(join(tmpdir(), "chrome-live-dedicated-"))
    tmpHomes.push(dataDir)
    const spawn = vi.fn(() => {
      const listeners: (() => void)[] = []
      return {
        pid: 4242,
        kill: () => {
          for (const listener of listeners.splice(0)) listener()
          return true
        },
        once: (_event: "exit", listener: () => void) => {
          listeners.push(listener)
        },
      }
    })
    const handle = createChromeLiveAdapter({
      launchDeps: {
        dataDir,
        findChrome: () => "/fake/chrome",
        findFreePort: async () => chrome.port,
        fetchJsonVersion: async () => ({ webSocketDebuggerUrl: `ws://127.0.0.1:${chrome.port}/devtools/browser` }),
        spawn,
      },
    })
    const instance = await handle.ensure({ env: {} })
    // The dedicated launcher ran (once) and the instance owns that pid — it
    // did NOT attach to the user's Chrome.
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(instance.pid).toBe(4242)
    await instance.stop()
  })

  it("ensure reports a closed port as browser:remote-debugging-off and refuses location=cloud", async () => {
    const handle = getBrowserAdapter("chrome-live")!
    await expect(handle.ensure({ port: await closedPort(), env: {} })).rejects.toMatchObject({ code: BROWSER_REMOTE_DEBUGGING_OFF_CODE })
    await expect(handle.ensure({ location: "cloud", baseUrl: "https://example.test" })).rejects.toThrow(/no cloud location/)
  })

  it("ensure with profile: \"personal\" still attaches to a reachable toggle-mode Chrome", async () => {
    const chrome = await toggleChrome()
    const handle = getBrowserAdapter("chrome-live")!
    const instance = await handle.ensure({ port: chrome.port, profile: "personal", env: {} })
    expect(instance).toMatchObject({ id: "chrome-live", port: chrome.port, wasAlreadyRunning: false, healthy: true })
    expect(instance.pid).toBeUndefined()
    await instance.stop()
  })
})

describe("createChromeLiveAdapter (injectable provider config)", () => {
  it("builds its own provider, independent of the default chromeLiveAdapter singleton", () => {
    const handle = createChromeLiveAdapter()
    expect(handle.id).toBe("chrome-live")
    expect(handle).not.toBe(chromeLiveProvider)
  })

  it("never calls a configured cookieSource on a bare attach (no tab was opened to inject into)", async () => {
    const chrome = await toggleChrome()
    const cookieSource = vi.fn().mockReturnValue([])
    const handle = createChromeLiveAdapter({ cookieSource })
    const instance = await handle.ensure({ port: chrome.port, env: {} })
    expect(cookieSource).not.toHaveBeenCalled()
    await instance.stop()
  })
})

describe("chromeLiveLaunchOptionsFrom (pure mapping, no network)", () => {
  it("profile: \"personal\" maps to attachIntent: true", () => {
    expect(chromeLiveLaunchOptionsFrom({ profile: "personal" })).toMatchObject({ attachIntent: true })
  })

  it("profile: \"dedicated\" leaves attachIntent unset (the provider's own dedicated-first default decides)", () => {
    expect(chromeLiveLaunchOptionsFrom({ profile: "dedicated" })).not.toHaveProperty("attachIntent")
  })

  it("no profile at all leaves attachIntent unset", () => {
    expect(chromeLiveLaunchOptionsFrom({})).not.toHaveProperty("attachIntent")
  })

  it("passes port and env through unchanged alongside profile", () => {
    expect(chromeLiveLaunchOptionsFrom({ port: 1234, env: { FOO: "bar" }, profile: "personal" })).toEqual({
      port: 1234,
      env: { FOO: "bar" },
      attachIntent: true,
    })
  })

  it("forwards chromeProfile and domains verbatim — pure passthrough, no validation", () => {
    expect(chromeLiveLaunchOptionsFrom({ chromeProfile: "Profile 3", domains: ["example.com", "sub.example.org"] })).toEqual({
      chromeProfile: "Profile 3",
      domains: ["example.com", "sub.example.org"],
    })
  })

  it("omits chromeProfile and domains when absent from the start options", () => {
    const opts = chromeLiveLaunchOptionsFrom({})
    expect(opts).not.toHaveProperty("chromeProfile")
    expect(opts).not.toHaveProperty("domains")
  })
})

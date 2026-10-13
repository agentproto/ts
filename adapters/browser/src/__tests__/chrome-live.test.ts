import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { WebSocketServer } from "ws"
import { BROWSER_REMOTE_DEBUGGING_OFF_CODE, chromeLive } from "@agentproto/adapter-browser-chrome"
import { browserAdapters, getBrowserAdapter } from "../index.js"
import { chromeLiveProvider } from "../adapters/chrome-live.js"

const servers: Server[] = []

afterEach(async () => {
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

  it("ensure reports a closed port as browser:remote-debugging-off and refuses location=cloud", async () => {
    const handle = getBrowserAdapter("chrome-live")!
    await expect(handle.ensure({ port: await closedPort(), env: {} })).rejects.toMatchObject({ code: BROWSER_REMOTE_DEBUGGING_OFF_CODE })
    await expect(handle.ensure({ location: "cloud", baseUrl: "https://example.test" })).rejects.toThrow(/no cloud location/)
  })
})

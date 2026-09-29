/**
 * L3b: projectBrowserTools (kit BrowserInstance -> browser_* MCP tools) and
 * the wire-compat of the lifecycle surface after the adapter rewire
 * (`start_browser {adapter:"camofox"}` and `POST /sessions/browser` resolve
 * through the `@agentproto/adapter-browser` facade with unchanged shapes).
 *
 * Fully in-process: fake providers, a fake camofox `/health` server on a
 * random port. No live camofox (:9377) and no Bureau (:8830).
 */

import { describe, it, expect, afterEach } from "vitest"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { createMcpServer } from "@agentproto/mcp-server"
import {
  assertCapability,
  defineBrowser,
  type BrowserDriver,
  type BrowserInstance,
  type BrowserManifestInput,
} from "@agentproto/driver-browser"

import { projectBrowserTools } from "../browser-projection.js"
import { registerBrowserTools } from "../browser-tools.js"
import { defaultBrowserAdapterResolution, defaultBrowserAdapterIds } from "../browser-adapters.js"
import { startHttpServer } from "../http-server.js"
import { createSessionsRegistry } from "../sessions.js"
import { createRuntimeEvents } from "../events.js"
import type { ConversationStore } from "../conversations.js"
import type { HeartbeatRunner } from "../heartbeat.js"

// ── Fakes ─────────────────────────────────────────────────────────────────────

interface FakeCalls {
  attaches: number
  driverCalls: string[]
  closed: number
}

function makeFake(manifest: Partial<BrowserManifestInput>, opts: { driverGuards?: boolean } = {}) {
  const calls: FakeCalls = { attaches: 0, driverCalls: [], closed: 0 }
  const cdp = manifest.capabilities?.cdp === true
  const provider = defineBrowser({
    id: "fake",
    name: "Fake",
    description: "in-memory provider for projection tests",
    version: "1.0.0",
    transport: "sdk",
    location: "local",
    ...manifest,
    async launch(): Promise<BrowserInstance> {
      const driver: BrowserDriver = {
        kind: "fake",
        capabilities: {
          canCaptureResponseBodies: cdp,
          canDispatchTrustedInput: false,
          canMultiTarget: false,
          canThrottleNetwork: false,
          isUserVisible: false,
          canScreencast: false,
          canRecordVideo: false,
          canStealth: false,
          canFullPageScreenshot: false,
          canAiActions: false,
        },
        target: { id: "tab-1" },
        async navigate(o) {
          calls.driverCalls.push(`navigate:${o.url}`)
        },
        async evaluate<T>() {
          calls.driverCalls.push("evaluate")
          return { value: 2 as T, truncated: false }
        },
        async click(o) {
          calls.driverCalls.push(`click:${o.selector}`)
        },
        async fill(o) {
          calls.driverCalls.push(`fill:${o.selector}`)
        },
        async screenshot() {
          calls.driverCalls.push("screenshot")
          return { base64: "AAAA", format: "png", width: 1, height: 1 }
        },
        async getDom() {
          calls.driverCalls.push("getDom")
          return "<html></html>"
        },
        async listRequests() {
          calls.driverCalls.push("listRequests")
          if (opts.driverGuards) assertCapability({ cdp }, "cdp", { tool: "browser.list_requests", providerId: "fake" })
          return [{ requestId: "r1", url: "https://example.test/", method: "GET", startedAt: 1 }]
        },
        async getRequestBody() {
          calls.driverCalls.push("getRequestBody")
          return { body: "{}", base64Encoded: false }
        },
        async send() {
          calls.driverCalls.push("send")
          return { ok: true } as never
        },
        onEvent: () => () => {},
        async close() {
          calls.closed++
        },
        closed: false,
      }
      return {
        id: "fake",
        endpoints: {},
        wasAlreadyRunning: false,
        health: async () => ({ ok: true }),
        attach: async () => {
          calls.attaches++
          return driver
        },
        stop: async () => {},
      }
    },
  })
  return { provider, calls }
}

async function connect(register: (server: McpServer) => void) {
  const server = new McpServer({ name: "projection-test", version: "0.0.1" })
  register(server)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "test-client", version: "0.0.1" })
  await client.connect(clientTransport)
  return client
}

interface ToolEnvelope {
  ok: false
  error: { code: string; message: string; cause?: { capability?: string; providerId?: string; tool?: string } }
}

// ── projectBrowserTools ───────────────────────────────────────────────────────

describe("projectBrowserTools", () => {
  const EXPECTED = [
    "browser_cdp_send",
    "browser_click",
    "browser_evaluate",
    "browser_fill",
    "browser_get_dom",
    "browser_get_request_body",
    "browser_list_requests",
    "browser_navigate",
    "browser_screenshot",
  ]

  it("full-capability provider exposes the existing browser_* tool set and every tool works", async () => {
    const { provider, calls } = makeFake({ capabilities: { cdp: true, downloads: true, canAiActions: true } })
    const instance = await provider.launch({}, {})
    const projected = projectBrowserTools(instance, { provider })
    const client = await connect((s) => projected.register(s))

    const listed = (await client.listTools()).tools.map((t) => t.name).sort()
    expect(listed).toEqual(EXPECTED)

    const nav = await client.callTool({ name: "browser_navigate", arguments: { url: "https://example.test/" } })
    expect(nav.isError).toBeFalsy()
    expect(nav.structuredContent).toEqual({ url: "https://example.test/" })

    const reqs = await client.callTool({ name: "browser_list_requests", arguments: {} })
    expect(reqs.isError).toBeFalsy()
    expect((reqs.structuredContent as { requests: unknown[] }).requests).toHaveLength(1)

    const cdpRes = await client.callTool({ name: "browser_cdp_send", arguments: { method: "Page.enable" } })
    expect(cdpRes.isError).toBeFalsy()
    const shot = await client.callTool({ name: "browser_screenshot", arguments: {} })
    expect(shot.structuredContent).toMatchObject({ base64: "AAAA", format: "png" })

    // one lazy attach shared by every call, closed once
    expect(calls.attaches).toBe(1)
    await projected.close()
    await projected.close()
    expect(calls.closed).toBe(1)
    await client.close()
  })

  it("browser_list_requests on a cdp:false provider returns typed unsupported naming cdp, without attaching", async () => {
    const { provider, calls } = makeFake({ capabilities: { cdp: false } })
    const instance = await provider.launch({}, {})
    const projected = projectBrowserTools(instance, { provider })
    const client = await connect((s) => projected.register(s))

    const res = await client.callTool({ name: "browser_list_requests", arguments: {} })
    expect(res.isError).toBe(true)
    const body = res.structuredContent as unknown as ToolEnvelope
    expect(body.ok).toBe(false)
    expect(body.error.code).toBe("browser:unsupported")
    expect(body.error.cause?.capability).toBe("cdp")
    expect(body.error.message).toContain("cdp")
    expect(body.error.message).toContain('"fake"')
    expect(calls.attaches).toBe(0)
    expect(calls.driverCalls).toEqual([])

    for (const name of ["browser_get_request_body", "browser_cdp_send"]) {
      const args = name === "browser_get_request_body" ? { requestId: "r1" } : { method: "Page.enable" }
      const r = await client.callTool({ name, arguments: args })
      expect(r.isError).toBe(true)
      expect((r.structuredContent as unknown as ToolEnvelope).error.cause?.capability).toBe("cdp")
    }

    // ungated tools still work on the same provider
    const nav = await client.callTool({ name: "browser_navigate", arguments: { url: "https://example.test/" } })
    expect(nav.isError).toBeFalsy()
    await projected.close()
    await client.close()
  })

  it("a typed unsupported thrown by the driver itself is surfaced, not turned into a crash or empty success", async () => {
    // Manifest claims cdp, the driver refuses: still the typed result.
    const { provider } = makeFake({ capabilities: { cdp: true } }, { driverGuards: false })
    const instance = await provider.launch({}, {})
    const original = instance.attach.bind(instance)
    instance.attach = async (o) => {
      const d = await original(o)
      d.listRequests = async () => {
        assertCapability({ cdp: false }, "cdp", { tool: "browser.list_requests", providerId: "fake" })
        return []
      }
      return d
    }
    const projected = projectBrowserTools(instance, { provider })
    const res = (await projected.tools.find((t) => t.name === "browser_list_requests")!.call({}))
    expect(res.isError).toBe(true)
    expect((res.structuredContent as unknown as ToolEnvelope).error).toMatchObject({
      code: "browser:unsupported",
      cause: { capability: "cdp" },
    })
  })

  it("a failing attach or driver error is an isError result, not a throw", async () => {
    const { provider } = makeFake({ capabilities: { cdp: true } })
    const instance = await provider.launch({}, {})
    instance.attach = async () => {
      throw new Error("no page")
    }
    const projected = projectBrowserTools(instance, { provider })
    const res = await projected.tools.find((t) => t.name === "browser_navigate")!.call({ url: "https://example.test/" })
    expect(res.isError).toBe(true)
    expect((res.structuredContent as unknown as ToolEnvelope).error.message).toBe("no page")
  })

  it("path on screenshot needs a host writer and never writes without one", async () => {
    const { provider } = makeFake({ capabilities: { cdp: true } })
    const instance = await provider.launch({}, {})
    const noWriter = projectBrowserTools(instance, { provider })
    const denied = await noWriter.tools.find((t) => t.name === "browser_screenshot")!.call({ path: "x.png" })
    expect(denied.isError).toBe(true)

    const written: string[] = []
    const withWriter = projectBrowserTools(instance, {
      provider,
      writeArtifact: (p, bytes) => {
        written.push(`${p}:${bytes.length}`)
        return `/artifacts/${p}`
      },
    })
    const ok = await withWriter.tools.find((t) => t.name === "browser_screenshot")!.call({ path: "x.png" })
    expect(ok.isError).toBeUndefined()
    expect(ok.structuredContent).toMatchObject({ path: "/artifacts/x.png", bytes: 3 })
    expect(written).toEqual(["x.png:3"])
  })
})

// ── Wire compat of the lifecycle surface (facade-backed) ──────────────────────

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))))
})

/** A fake camofox: answers GET /health like the real server does. */
async function fakeCamofox(): Promise<number> {
  const srv = createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ ok: true, bootId: "boot-1", browserState: "running" }))
      return
    }
    res.writeHead(404).end()
  })
  servers.push(srv)
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r))
  return (srv.address() as AddressInfo).port
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as AddressInfo).port
      srv.close(() => resolve(port))
    })
  })
}

function noopConversations(): ConversationStore {
  return {
    async open() {},
    async appendTurn() {},
    async read() {
      return { meta: {} as never, turns: [] }
    },
    async list() {
      return []
    },
    pathFor: (id: string) => id,
  }
}
function noopHeartbeat(): HeartbeatRunner {
  return { start() {}, stop() {}, async fireNow() {} }
}

describe("default browser adapter resolution (facade)", () => {
  it("lists the camofox, bureau and chromium ids with unchanged row fields", () => {
    const { listBrowserAdapters, resolveBrowserAdapter } = defaultBrowserAdapterResolution()
    expect(defaultBrowserAdapterIds()).toEqual(["camofox", "bureau", "chromium"])
    const rows = listBrowserAdapters()
    expect(rows.map((r) => r.id)).toEqual(["camofox", "bureau", "chromium"])
    expect(Object.keys(rows[0]!).sort()).toEqual(
      ["config", "defaultPort", "description", "id", "install", "location", "name"].sort(),
    )
    expect(rows[0]).toMatchObject({ id: "camofox", defaultPort: 9377, location: "local" })
    expect(resolveBrowserAdapter("nope")).toBeUndefined()
  })
})

describe("start_browser {adapter:'camofox'} and POST /sessions/browser: response shapes unchanged", () => {
  it("start_browser returns the recorded key set and reuses the healthy server", async () => {
    const camofoxPort = await fakeCamofox()
    const registry = createSessionsRegistry({ persist: false })
    const { listBrowserAdapters, resolveBrowserAdapter } = defaultBrowserAdapterResolution()
    const client = await connect((s) =>
      registerBrowserTools(s, { registry, listBrowserAdapters, resolveBrowserAdapter }),
    )
    const res = await client.callTool({ name: "start_browser", arguments: { adapter: "camofox", port: camofoxPort } })
    expect(res.isError).toBeFalsy()
    const body = JSON.parse((res.content as { text: string }[])[0]!.text) as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(
      ["browserAdapterId", "browserBaseUrl", "browserPort", "sessionId", "status", "wasAlreadyRunning"].sort(),
    )
    expect(body).toMatchObject({
      browserAdapterId: "camofox",
      browserPort: camofoxPort,
      browserBaseUrl: `http://127.0.0.1:${camofoxPort}`,
      wasAlreadyRunning: true,
      status: "running",
    })

    const unknown = await client.callTool({ name: "start_browser", arguments: { adapter: "nope" } })
    expect(unknown.isError).toBe(true)
    expect((unknown.content as { text: string }[])[0]!.text).toContain("Available adapters: camofox, bureau, chromium")
    registry.shutdown()
    await client.close()
  })

  it("POST /sessions/browser returns the recorded 201 descriptor shape", async () => {
    const camofoxPort = await fakeCamofox()
    const registry = createSessionsRegistry({ persist: false })
    const { listBrowserAdapters, resolveBrowserAdapter } = defaultBrowserAdapterResolution()
    const port = await freePort()
    const http = await startHttpServer({
      port,
      auth: { mode: "none" },
      mcpServerFactory: async () => (await createMcpServer({ specs: [], name: "main", version: "0" })).server,
      conversations: noopConversations(),
      events: createRuntimeEvents(),
      heartbeat: noopHeartbeat(),
      sessions: registry,
      meta: { workspace: process.cwd(), registered: [] },
      resolveBrowserAdapter,
      listBrowserAdapters,
    })
    try {
      const base = `http://127.0.0.1:${port}`
      const res = await fetch(`${base}/sessions/browser`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ adapter: "camofox", port: camofoxPort, label: "l3b" }),
      })
      expect(res.status).toBe(201)
      const desc = (await res.json()) as Record<string, unknown>
      expect(desc).toMatchObject({
        kind: "browser",
        browserAdapterId: "camofox",
        browserPort: camofoxPort,
        browserBaseUrl: `http://127.0.0.1:${camofoxPort}`,
        status: "running",
        label: "l3b",
      })
      expect(typeof desc.id).toBe("string")

      const missing = await fetch(`${base}/sessions/browser`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ adapter: "nope" }),
      })
      expect(missing.status).toBe(404)
      expect(await missing.json()).toEqual({
        error: "adapter_not_found",
        adapter: "nope",
        message: 'Browser adapter "nope" not found. Available: camofox, bureau, chromium.',
      })
    } finally {
      await http.stop()
      registry.shutdown()
    }
  })
})

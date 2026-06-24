/**
 * Tests for registerBrowserTools (T11 — manifest fields exposed over MCP).
 *
 * Verifies:
 *   (a) list_adapter_browsers surfaces location/install/config from the lister
 *   (b) start_browser accepts location/baseUrl/binPath in its zod schema
 *
 * Runs fully in-process — no daemon or real browser adapter needed.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"

import {
  registerBrowserTools,
  type BrowserAdapterLister,
  type BrowserAdapterResolver,
} from "../browser-tools.js"
import { createSessionsRegistry } from "../sessions.js"

// ── Helpers ───────────────────────────────────────────────────────────────────

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "browser-tools-test-"))
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

async function makeSetup(opts: {
  listBrowserAdapters?: BrowserAdapterLister
  resolveBrowserAdapter?: BrowserAdapterResolver
}) {
  const registry = createSessionsRegistry({ persistPath: join(tmp, "sessions.json") })
  const server = new McpServer({ name: "test-browser", version: "0.0.1" })

  registerBrowserTools(server, {
    registry,
    listBrowserAdapters: opts.listBrowserAdapters,
    resolveBrowserAdapter: opts.resolveBrowserAdapter,
  })

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "test-client", version: "0.0.1" })
  await client.connect(clientTransport)

  const cleanup = async () => {
    await client.close()
    registry.shutdown()
  }

  return { client, cleanup }
}

// ── (a) list_adapter_browsers surfaces manifest fields ────────────────────────

describe("list_adapter_browsers — manifest fields", () => {
  const mockLister: BrowserAdapterLister = () => [
    {
      id: "camofox",
      name: "Camofox",
      description: "Headless Chrome adapter",
      defaultPort: 9377,
      location: "local",
      install: [{ method: "vendored" }],
      config: [{ id: "step-1", kind: "prompt", prompt: "Enter API key" }],
    },
    {
      id: "bureau",
      name: "Bureau",
      description: "Cloud browser service",
      defaultPort: 9178,
      location: "cloud",
    },
  ]

  it("surfaces location on each adapter", async () => {
    const { client, cleanup } = await makeSetup({ listBrowserAdapters: mockLister })

    const result = await client.callTool({ name: "list_adapter_browsers", arguments: {} })
    expect(result.isError).toBeFalsy()
    const adapters = JSON.parse(
      (result.content as Array<{ type: string; text: string }>)[0]!.text
    ) as Array<{ id: string; location?: string }>

    expect(adapters.find(a => a.id === "camofox")?.location).toBe("local")
    expect(adapters.find(a => a.id === "bureau")?.location).toBe("cloud")

    await cleanup()
  })

  it("surfaces install and config arrays on camofox", async () => {
    const { client, cleanup } = await makeSetup({ listBrowserAdapters: mockLister })

    const result = await client.callTool({ name: "list_adapter_browsers", arguments: {} })
    const adapters = JSON.parse(
      (result.content as Array<{ type: string; text: string }>)[0]!.text
    ) as Array<{ id: string; install?: unknown[]; config?: unknown[] }>

    const camofox = adapters.find(a => a.id === "camofox")
    expect(camofox?.install).toHaveLength(1)
    expect(camofox?.config).toHaveLength(1)

    await cleanup()
  })

  it("omits install/config when not declared (bureau)", async () => {
    const { client, cleanup } = await makeSetup({ listBrowserAdapters: mockLister })

    const result = await client.callTool({ name: "list_adapter_browsers", arguments: {} })
    const adapters = JSON.parse(
      (result.content as Array<{ type: string; text: string }>)[0]!.text
    ) as Array<{ id: string; install?: unknown[]; config?: unknown[] }>

    const bureau = adapters.find(a => a.id === "bureau")
    expect(bureau?.install).toBeUndefined()
    expect(bureau?.config).toBeUndefined()

    await cleanup()
  })
})

// ── (b) start_browser schema accepts location/baseUrl/binPath ─────────────────

describe("start_browser — schema accepts manifest runtime knobs", () => {
  it("accepts location='cloud' + baseUrl without schema error", async () => {
    // The mock resolver returns a cloud-mode adapter that succeeds immediately.
    const mockResolver: BrowserAdapterResolver = (id) => {
      if (id !== "cloud-browser") return undefined
      return {
        id: "cloud-browser",
        name: "Cloud Browser",
        description: "Remote browser",
        defaultPort: 9000,
        healthPath: "/health",
        location: "cloud",
        ensure: async (opts) => ({
          id: "cloud-browser",
          port: opts.port ?? 9000,
          baseUrl: opts.baseUrl ?? "https://example.com",
          pid: undefined,
          wasAlreadyRunning: false,
          healthy: true,
          stop: async () => {},
        }),
      }
    }

    const { client, cleanup } = await makeSetup({ resolveBrowserAdapter: mockResolver })

    const result = await client.callTool({
      name: "start_browser",
      arguments: {
        adapter: "cloud-browser",
        location: "cloud",
        baseUrl: "https://example.com",
      },
    })

    // Should succeed (not a schema validation error)
    expect(result.isError).toBeFalsy()
    const data = JSON.parse(
      (result.content as Array<{ type: string; text: string }>)[0]!.text
    ) as { browserAdapterId: string }
    expect(data.browserAdapterId).toBe("cloud-browser")

    await cleanup()
  })

  it("accepts binPath as an optional string without schema error", async () => {
    let capturedBinPath: string | undefined = undefined

    const mockResolver: BrowserAdapterResolver = (id) => {
      if (id !== "local-browser") return undefined
      return {
        id: "local-browser",
        name: "Local Browser",
        description: "Local adapter with custom bin",
        defaultPort: 9001,
        healthPath: "/health",
        location: "local",
        ensure: async (opts) => {
          capturedBinPath = opts.binPath
          return {
            id: "local-browser",
            port: opts.port ?? 9001,
            baseUrl: "http://127.0.0.1:9001",
            pid: 12345,
            wasAlreadyRunning: false,
            healthy: true,
            stop: async () => {},
          }
        },
      }
    }

    const { client, cleanup } = await makeSetup({ resolveBrowserAdapter: mockResolver })

    const result = await client.callTool({
      name: "start_browser",
      arguments: {
        adapter: "local-browser",
        binPath: "/custom/path/to/browser",
      },
    })

    expect(result.isError).toBeFalsy()
    // Verify binPath was forwarded into ensure()
    expect(capturedBinPath).toBe("/custom/path/to/browser")

    await cleanup()
  })

  it("start_browser without new fields still works (backwards-compatible)", async () => {
    const mockResolver: BrowserAdapterResolver = (id) => {
      if (id !== "plain") return undefined
      return {
        id: "plain",
        name: "Plain",
        description: "Basic adapter",
        defaultPort: 9002,
        healthPath: "/health",
        ensure: async (opts) => ({
          id: "plain",
          port: opts.port ?? 9002,
          baseUrl: "http://127.0.0.1:9002",
          wasAlreadyRunning: true,
          healthy: true,
          stop: async () => {},
        }),
      }
    }

    const { client, cleanup } = await makeSetup({ resolveBrowserAdapter: mockResolver })

    const result = await client.callTool({
      name: "start_browser",
      arguments: { adapter: "plain" },
    })

    expect(result.isError).toBeFalsy()

    await cleanup()
  })
})

// ── browser_screenshot ────────────────────────────────────────────────────────

/**
 * Builds a minimal browser session directly in the registry (bypasses
 * start_browser) so the screenshot tests don't need a real adapter.
 */
function registerBrowserSession(
  registry: ReturnType<typeof import("../sessions.js").createSessionsRegistry>,
  opts: {
    adapterId: string
    baseUrl: string
  }
) {
  return registry.registerBrowser({
    adapterId: opts.adapterId,
    port: 9999,
    baseUrl: opts.baseUrl,
    wasAlreadyRunning: false,
    status: "running",
    stop: async () => {},
  })
}

async function makeScreenshotSetup() {
  const registry = createSessionsRegistry({ persistPath: join(tmp, "sessions-shot.json") })
  const server = new McpServer({ name: "test-screenshot", version: "0.0.1" })
  registerBrowserTools(server, { registry })

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "test-client", version: "0.0.1" })
  await client.connect(clientTransport)

  const cleanup = async () => {
    await client.close()
    registry.shutdown()
    vi.unstubAllGlobals()
  }

  return { client, registry, cleanup }
}

function parseResult(result: Awaited<ReturnType<Client["callTool"]>>) {
  return JSON.parse((result.content as Array<{ type: string; text: string }>)[0]!.text)
}

describe("browser_screenshot — error shapes", () => {
  it("session-not-found returns isError + message", async () => {
    const { client, cleanup } = await makeScreenshotSetup()

    const result = await client.callTool({
      name: "browser_screenshot",
      arguments: { sessionId: "does-not-exist" },
    })

    expect(result.isError).toBe(true)
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text
    expect(text).toContain("browser_screenshot:")
    expect(text).toContain("does-not-exist")
    expect(text).toContain("not found")

    await cleanup()
  })

  it("unsupported-adapter returns isError + message listing supported adapters", async () => {
    const { client, registry, cleanup } = await makeScreenshotSetup()
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }))

    const desc = registerBrowserSession(registry, {
      adapterId: "unknown-adapter",
      baseUrl: "http://127.0.0.1:9999",
    })

    const result = await client.callTool({
      name: "browser_screenshot",
      arguments: { sessionId: desc.id },
    })

    expect(result.isError).toBe(true)
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text
    expect(text).toContain("browser_screenshot:")
    expect(text).toContain("unknown-adapter")
    expect(text).toContain("camofox")
    expect(text).toContain("bureau")
    expect(text).toContain("chromium")

    await cleanup()
  })
})

describe("browser_screenshot — camofox dispatch", () => {
  it("returns base64 data + format when tabId is provided", async () => {
    const { client, registry, cleanup } = await makeScreenshotSetup()

    const pngBytes = Buffer.from("fake-png-bytes")
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => pngBytes.buffer,
    })
    vi.stubGlobal("fetch", mockFetch)

    const desc = registerBrowserSession(registry, {
      adapterId: "camofox",
      baseUrl: "http://localhost:9377",
    })

    const result = await client.callTool({
      name: "browser_screenshot",
      arguments: { sessionId: desc.id, tabId: "tab-1" },
    })

    expect(result.isError).toBeFalsy()
    const data = parseResult(result)
    expect(data.format).toBe("png")
    expect(typeof data.data).toBe("string")
    // fetch should have been called with the IPv4-normalised URL
    expect(mockFetch.mock.calls[0]![0]).toContain("127.0.0.1")
    expect(mockFetch.mock.calls[0]![0]).toContain("/tabs/tab-1/screenshot")

    await cleanup()
  })

  it("resolves default tab when tabId is omitted", async () => {
    const { client, registry, cleanup } = await makeScreenshotSetup()

    const pngBytes = Buffer.from("fake-png")
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ tabs: [{ tabId: "auto-tab" }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => pngBytes.buffer,
      })
    vi.stubGlobal("fetch", mockFetch)

    const desc = registerBrowserSession(registry, {
      adapterId: "camofox",
      baseUrl: "http://127.0.0.1:9377",
    })

    const result = await client.callTool({
      name: "browser_screenshot",
      arguments: { sessionId: desc.id },
    })

    expect(result.isError).toBeFalsy()
    expect(mockFetch).toHaveBeenCalledTimes(2)
    // second call uses the resolved tabId
    expect(mockFetch.mock.calls[1]![0]).toContain("/tabs/auto-tab/screenshot")

    await cleanup()
  })
})

describe("browser_screenshot — bureau dispatch", () => {
  it("calls bureau /mcp with browser_screenshot tool name and returns data", async () => {
    const { client, registry, cleanup } = await makeScreenshotSetup()

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        result: {
          content: [{ type: "text", text: JSON.stringify({ base64: "abc123", format: "png", width: 1280, height: 800 }) }],
        },
      }),
    })
    vi.stubGlobal("fetch", mockFetch)

    const desc = registerBrowserSession(registry, {
      adapterId: "bureau",
      baseUrl: "http://127.0.0.1:8830",
    })

    const result = await client.callTool({
      name: "browser_screenshot",
      arguments: { sessionId: desc.id },
    })

    expect(result.isError).toBeFalsy()
    const data = parseResult(result)
    expect(data.data).toBe("abc123")
    expect(data.format).toBe("png")
    expect(data.width).toBe(1280)
    expect(data.height).toBe(800)

    // Verify dispatch used bureau's internal browser_screenshot tool name
    const body = JSON.parse(mockFetch.mock.calls[0]![1].body as string)
    expect(body.params.name).toBe("browser_screenshot")

    // Regression: bureau /mcp (StreamableHTTP) returns HTTP 406 unless Accept includes text/event-stream
    const bureauHeaders = mockFetch.mock.calls[0]![1].headers as Record<string, string>
    expect(bureauHeaders.accept).toContain("text/event-stream")

    await cleanup()
  })
})

describe("browser_screenshot — chromium dispatch", () => {
  it("calls chromium /sessions/:id/screenshot and returns data", async () => {
    const { client, registry, cleanup } = await makeScreenshotSetup()

    const pngBytes = Buffer.from("chromium-png")
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ sessions: [{ id: "cr-session-1" }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => pngBytes.buffer,
      })
    vi.stubGlobal("fetch", mockFetch)

    const desc = registerBrowserSession(registry, {
      adapterId: "chromium",
      baseUrl: "http://127.0.0.1:3200",
    })

    const result = await client.callTool({
      name: "browser_screenshot",
      arguments: { sessionId: desc.id },
    })

    expect(result.isError).toBeFalsy()
    const data = parseResult(result)
    expect(data.format).toBe("png")
    expect(mockFetch.mock.calls[1]![0]).toContain("/sessions/cr-session-1/screenshot")

    await cleanup()
  })

  it("uses provided tabId as chromium sessionId without listing", async () => {
    const { client, registry, cleanup } = await makeScreenshotSetup()

    const pngBytes = Buffer.from("cr-png")
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => pngBytes.buffer,
    })
    vi.stubGlobal("fetch", mockFetch)

    const desc = registerBrowserSession(registry, {
      adapterId: "chromium",
      baseUrl: "http://127.0.0.1:3200",
    })

    await client.callTool({
      name: "browser_screenshot",
      arguments: { sessionId: desc.id, tabId: "explicit-cr-session" },
    })

    // Only one fetch call (no /sessions listing)
    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(mockFetch.mock.calls[0]![0]).toContain("/sessions/explicit-cr-session/screenshot")

    await cleanup()
  })
})

describe("browser_screenshot — abort timer cleanup", () => {
  it("guard-return path never invokes fetch (timer never created)", async () => {
    const { client, cleanup } = await makeScreenshotSetup()
    // AbortController + timer are created AFTER all guard-returns. If fetch is
    // never called it means the guard fired before any timer was set up.
    const mockFetch = vi.fn()
    vi.stubGlobal("fetch", mockFetch)

    const result = await client.callTool({
      name: "browser_screenshot",
      arguments: { sessionId: "ghost-session" },
    })

    expect(result.isError).toBe(true)
    expect(mockFetch).not.toHaveBeenCalled()
    await cleanup()
  })

  it("abort timer cleared after successful fetch (no extra clearTimeout vs guard baseline)", async () => {
    // The MCP SDK sets+clears its own request-timeout timer on every tool call.
    // That accounts for a baseline of N clearTimeout calls even on a guard-return.
    // A successful network path adds exactly one more (our finally { clearTimeout(timer) }).
    // We measure the delta to isolate our timer.
    const { client: guardClient, cleanup: guardCleanup } = await makeScreenshotSetup()
    vi.stubGlobal("fetch", vi.fn())
    const guardSpy = vi.spyOn(globalThis, "clearTimeout")
    await guardClient.callTool({ name: "browser_screenshot", arguments: { sessionId: "ghost" } })
    const baseline = guardSpy.mock.calls.length
    guardSpy.mockRestore()
    vi.unstubAllGlobals()
    await guardCleanup()

    // Now measure a successful fetch path.
    const { client, registry, cleanup } = await makeScreenshotSetup()
    const pngBytes = Buffer.from("ok-png")
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ tabs: [{ tabId: "t1" }] }) })
      .mockResolvedValueOnce({ ok: true, arrayBuffer: async () => pngBytes.buffer })
    )
    const desc = registerBrowserSession(registry, { adapterId: "camofox", baseUrl: "http://127.0.0.1:9377" })
    const netSpy = vi.spyOn(globalThis, "clearTimeout")
    await client.callTool({ name: "browser_screenshot", arguments: { sessionId: desc.id } })
    const netCalls = netSpy.mock.calls.length
    netSpy.mockRestore()

    // Network path must clear exactly one more timer than the guard baseline
    expect(netCalls).toBe(baseline + 1)
    await cleanup()
  })
})

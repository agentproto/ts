/**
 * Tests for registerBrowserTools (T11 — manifest fields exposed over MCP).
 *
 * Verifies:
 *   (a) list_adapter_browsers surfaces location/install/config from the lister
 *   (b) start_browser accepts location/baseUrl/binPath in its zod schema
 *
 * Runs fully in-process — no daemon or real browser adapter needed.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
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

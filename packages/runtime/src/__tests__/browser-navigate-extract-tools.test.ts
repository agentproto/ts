/**
 * Tests for the three page-reading tools added alongside start_browser:
 * fetch_page (plain HTTP, no adapter needed), browser_navigate and
 * browser_extract_text (chrome-live only, dispatch through `liveInstances`
 * the same way browser_screenshot does).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"

import { registerBrowserTools, setLiveBrowserInstance } from "../browser-tools.js"
import { createSessionsRegistry, type SessionsRegistry } from "../sessions.js"

let tmp: string
let registry: SessionsRegistry

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "browser-navigate-extract-test-"))
  registry = createSessionsRegistry({ persistPath: join(tmp, "sessions.json") })
})

afterEach(() => {
  registry.shutdown()
  rmSync(tmp, { recursive: true, force: true })
})

async function makeClient() {
  const server = new McpServer({ name: "test-browser", version: "0.0.1" })
  registerBrowserTools(server, { registry })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "test-client", version: "0.0.1" })
  await client.connect(clientTransport)
  return { client, cleanup: () => client.close() }
}

function parse(result: unknown): Record<string, unknown> {
  const content = (result as { content: Array<{ type: string; text?: string }> }).content
  const text = content.find((c) => c.type === "text")?.text
  return text ? (JSON.parse(text) as Record<string, unknown>) : {}
}

function textOf(result: unknown): string | undefined {
  const content = (result as { content: Array<{ type: string; text?: string }> }).content
  return content.find((c) => c.type === "text")?.text
}

function registerChromeLiveSession(): string {
  const desc = registry.registerBrowser({
    adapterId: "chrome-live",
    port: 9222,
    baseUrl: "http://127.0.0.1:9222",
    wasAlreadyRunning: false,
    stop: async () => {},
  })
  return desc.id
}

// ── fetch_page ────────────────────────────────────────────────────────────────

describe("fetch_page", () => {
  const servers: Server[] = []
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))))
  })

  async function serve(status: number, body: string, headers: Record<string, string> = {}): Promise<number> {
    const server = createServer((_req, res) => {
      res.writeHead(status, headers)
      res.end(body)
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    return (server.address() as AddressInfo).port
  }

  it("reads a plain page: title + markdown text, blocked: false", async () => {
    const port = await serve(200, "<html><head><title>Hello</title></head><body><article><h1>Hello</h1><p>World.</p></article></body></html>")
    const { client, cleanup } = await makeClient()
    const result = await client.callTool({ name: "fetch_page", arguments: { url: `http://127.0.0.1:${port}/` } })
    expect(result.isError).toBeFalsy()
    const data = parse(result)
    expect(data.blocked).toBe(false)
    expect(String(data.text)).toContain("World")
    await cleanup()
  })

  it("reports blocked: true on a 403, without text", async () => {
    const port = await serve(403, "Forbidden")
    const { client, cleanup } = await makeClient()
    const result = await client.callTool({ name: "fetch_page", arguments: { url: `http://127.0.0.1:${port}/` } })
    expect(result.isError).toBeFalsy()
    const data = parse(result)
    expect(data.blocked).toBe(true)
    expect(data.status).toBe(403)
    expect(data.text).toBeUndefined()
    await cleanup()
  })

  it("reports blocked: true on a 200 Cloudflare challenge page (fingerprint, not status)", async () => {
    const port = await serve(200, "<html><body>Checking your browser before accessing. cf-browser-verification</body></html>")
    const { client, cleanup } = await makeClient()
    const result = await client.callTool({ name: "fetch_page", arguments: { url: `http://127.0.0.1:${port}/` } })
    const data = parse(result)
    expect(data.blocked).toBe(true)
    await cleanup()
  })

  it("surfaces a real HTTP error (e.g. 500) as an error result, not blocked", async () => {
    const port = await serve(500, "boom")
    const { client, cleanup } = await makeClient()
    const result = await client.callTool({ name: "fetch_page", arguments: { url: `http://127.0.0.1:${port}/` } })
    expect(result.isError).toBe(true)
    await cleanup()
  })
})

// ── browser_navigate / browser_extract_text ──────────────────────────────────

describe("browser_navigate", () => {
  it("dispatches to the chrome-live instance's navigate(url, tabId)", async () => {
    const sessionId = registerChromeLiveSession()
    let captured: [string, string | undefined] | undefined
    setLiveBrowserInstance(sessionId, {
      id: "chrome-live",
      port: 9222,
      baseUrl: "http://127.0.0.1:9222",
      wasAlreadyRunning: true,
      healthy: true,
      stop: async () => {},
      navigate: async (url, tabId) => {
        captured = [url, tabId]
        return { targetId: "agent-target-1", url }
      },
    })
    const { client, cleanup } = await makeClient()
    const result = await client.callTool({ name: "browser_navigate", arguments: { sessionId, url: "https://example.test" } })
    expect(result.isError).toBeFalsy()
    expect(parse(result)).toMatchObject({ targetId: "agent-target-1", url: "https://example.test" })
    expect(captured).toEqual(["https://example.test", undefined])
    await cleanup()
  })

  it("rejects a non-chrome-live adapter", async () => {
    const desc = registry.registerBrowser({
      adapterId: "camofox",
      port: 9377,
      baseUrl: "http://127.0.0.1:9377",
      wasAlreadyRunning: true,
      stop: async () => {},
    })
    const { client, cleanup } = await makeClient()
    const result = await client.callTool({ name: "browser_navigate", arguments: { sessionId: desc.id, url: "https://example.test" } })
    expect(result.isError).toBe(true)
    await cleanup()
  })

  it("errors clearly when the chrome-live instance is unavailable", async () => {
    const sessionId = registerChromeLiveSession()
    const { client, cleanup } = await makeClient()
    const result = await client.callTool({ name: "browser_navigate", arguments: { sessionId, url: "https://example.test" } })
    expect(result.isError).toBe(true)
    await cleanup()
  })
})

describe("browser_extract_text", () => {
  it("purifies the owned tab's DOM into { title, text, url }", async () => {
    const sessionId = registerChromeLiveSession()
    setLiveBrowserInstance(sessionId, {
      id: "chrome-live",
      port: 9222,
      baseUrl: "http://127.0.0.1:9222",
      wasAlreadyRunning: true,
      healthy: true,
      stop: async () => {},
      getDom: async () => ({
        targetId: "agent-target-1",
        url: "https://example.test/article",
        html: "<html><head><title>Piece</title></head><body><article><h1>Piece</h1><p>Body text.</p></article></body></html>",
      }),
    })
    const { client, cleanup } = await makeClient()
    const result = await client.callTool({ name: "browser_extract_text", arguments: { sessionId } })
    expect(result.isError).toBeFalsy()
    const data = parse(result)
    expect(data.url).toBe("https://example.test/article")
    expect(String(data.text)).toContain("Body text")
    await cleanup()
  })

  it("propagates the ownership error ('no agent-owned tab') from a navigate-less instance", async () => {
    const sessionId = registerChromeLiveSession()
    setLiveBrowserInstance(sessionId, {
      id: "chrome-live",
      port: 9222,
      baseUrl: "http://127.0.0.1:9222",
      wasAlreadyRunning: true,
      healthy: true,
      stop: async () => {},
      getDom: async () => {
        throw new Error("[chrome-live] no agent-owned tab is open to read")
      },
    })
    const { client, cleanup } = await makeClient()
    const result = await client.callTool({ name: "browser_extract_text", arguments: { sessionId } })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toMatch(/no agent-owned tab/)
    await cleanup()
  })
})

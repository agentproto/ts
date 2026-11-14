/**
 * Tests for fetch_page (plain HTTP, no browser). The page tools forward to
 * Bureau and are covered by browser-proxy.test.ts.
 */

import { afterEach, describe, expect, it } from "vitest"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"

import { registerBrowserTools } from "../browser-tools.js"

async function makeClient() {
  const server = new McpServer({ name: "test-browser", version: "0.0.1" })
  registerBrowserTools(server, { builtin: "off" })
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

  it("does NOT report blocked on an ordinary Cloudflare-fronted page using email obfuscation or Rocket Loader (regression: bare /cdn-cgi/ is not challenge-specific)", async () => {
    const port = await serve(
      200,
      "<html><head><script src=\"/cdn-cgi/scripts/rocket-loader.js\"></script></head>" +
        "<body><article><h1>Contact</h1><p>Email <a href=\"/cdn-cgi/l/email-protection#abc\">us</a>.</p></article></body></html>"
    )
    const { client, cleanup } = await makeClient()
    const result = await client.callTool({ name: "fetch_page", arguments: { url: `http://127.0.0.1:${port}/` } })
    const data = parse(result)
    expect(data.blocked).toBe(false)
    // defuddle >=0.15 lifts a title-like <h1> into `title` and drops it from the body.
    expect(String(data.title)).toContain("Contact")
    expect(String(data.text)).toContain("Email")
    await cleanup()
  })

  it("does NOT report blocked on an ordinary article that merely mentions bot-detection vendors or phrases", async () => {
    const port = await serve(
      200,
      "<html><body><article><h1>How Akamai stops bots</h1>" +
        "<p>Sites use an access denied page and ask are you a robot to challenge suspicious traffic.</p></article></body></html>"
    )
    const { client, cleanup } = await makeClient()
    const result = await client.callTool({ name: "fetch_page", arguments: { url: `http://127.0.0.1:${port}/` } })
    const data = parse(result)
    expect(data.blocked).toBe(false)
    expect(String(data.title)).toContain("Akamai")
    expect(String(data.text)).toContain("are you a robot")
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

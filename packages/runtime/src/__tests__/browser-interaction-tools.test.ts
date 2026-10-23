/**
 * Tests for the chrome-live interaction tools that stop an agent from having to
 * hand-roll DOM evaluation: browser_press_key, browser_select and browser_wait_for.
 * They dispatch through the same module-scope `liveInstances` map as
 * browser_click/browser_fill/browser_scroll.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
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
  tmp = mkdtempSync(join(tmpdir(), "browser-interaction-test-"))
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
  return registry.registerBrowser({
    adapterId: "chrome-live",
    port: 9222,
    baseUrl: "http://127.0.0.1:9222",
    wasAlreadyRunning: false,
    stop: async () => {},
  }).id
}

const baseInstance = () => ({
  id: "chrome-live",
  port: 9222,
  baseUrl: "http://127.0.0.1:9222",
  wasAlreadyRunning: true,
  healthy: true,
  stop: async () => {},
})

describe("browser_press_key", () => {
  it("dispatches key + optional focus selector/count/modifiers to the chrome-live instance", async () => {
    const sessionId = registerChromeLiveSession()
    let captured: [unknown, string | undefined] | undefined
    setLiveBrowserInstance(sessionId, {
      ...baseInstance(),
      pressKey: async (options, tabId) => {
        captured = [options, tabId]
        return { targetId: "agent-target-1", key: options.key }
      },
    })
    const { client, cleanup } = await makeClient()
    const result = await client.callTool({
      name: "browser_press_key",
      arguments: { sessionId, tabId: "agent-target-1", key: "ArrowDown", selector: "#list", count: 2, modifiers: ["Shift"] },
    })
    expect(result.isError).toBeFalsy()
    expect(parse(result)).toEqual({ targetId: "agent-target-1", key: "ArrowDown" })
    expect(captured).toEqual([
      { key: "ArrowDown", selector: "#list", count: 2, modifiers: ["Shift"] },
      "agent-target-1",
    ])
    await cleanup()
  })

  it("propagates the provider's unsupported-key error", async () => {
    const sessionId = registerChromeLiveSession()
    setLiveBrowserInstance(sessionId, {
      ...baseInstance(),
      pressKey: async () => {
        throw new Error('[chrome-live] unsupported key "Nope"')
      },
    })
    const { client, cleanup } = await makeClient()
    const result = await client.callTool({ name: "browser_press_key", arguments: { sessionId, key: "Nope" } })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toMatch(/unsupported key/)
    await cleanup()
  })
})

describe("browser_select", () => {
  it("dispatches value/label/index to the chrome-live instance and returns the committed option", async () => {
    const sessionId = registerChromeLiveSession()
    let captured: unknown
    setLiveBrowserInstance(sessionId, {
      ...baseInstance(),
      selectOption: async (options) => {
        captured = options
        return { targetId: "agent-target-1", value: "de", label: "Allemagne", index: 1 }
      },
    })
    const { client, cleanup } = await makeClient()
    const result = await client.callTool({ name: "browser_select", arguments: { sessionId, selector: "#country", label: "Allemagne" } })
    expect(result.isError).toBeFalsy()
    expect(parse(result)).toEqual({ targetId: "agent-target-1", value: "de", label: "Allemagne", index: 1 })
    expect(captured).toEqual({ selector: "#country", label: "Allemagne" })
    await cleanup()
  })

  it("rejects more than one selector when the schema is bypassed through the tool call", async () => {
    const sessionId = registerChromeLiveSession()
    setLiveBrowserInstance(sessionId, { ...baseInstance(), selectOption: async () => { throw new Error("should not run") } })
    const { client, cleanup } = await makeClient()
    // The MCP schema accepts value/label/index as optional, so the tool handler
    // validates exactly one is present.
    const result = await client.callTool({ name: "browser_select", arguments: { sessionId, selector: "#country" } })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toMatch(/value, label or index/)
    await cleanup()
  })
})

describe("browser_wait_for", () => {
  it("dispatches selector/state/text/timeout to the chrome-live instance", async () => {
    const sessionId = registerChromeLiveSession()
    let captured: unknown
    setLiveBrowserInstance(sessionId, {
      ...baseInstance(),
      waitFor: async (options) => {
        captured = options
        return { targetId: "agent-target-1", state: "text", matched: true, elapsedMs: 12 }
      },
    })
    const { client, cleanup } = await makeClient()
    const result = await client.callTool({
      name: "browser_wait_for",
      arguments: { sessionId, selector: "#status", state: "text", text: "Ready", timeoutMs: 5000 },
    })
    expect(result.isError).toBeFalsy()
    expect(parse(result)).toEqual({ targetId: "agent-target-1", state: "text", matched: true, elapsedMs: 12 })
    expect(captured).toEqual({ selector: "#status", state: "text", text: "Ready", timeoutMs: 5000 })
    await cleanup()
  })

  it("errors clearly when the chrome-live instance is unavailable", async () => {
    const sessionId = registerChromeLiveSession()
    const { client, cleanup } = await makeClient()
    const result = await client.callTool({ name: "browser_wait_for", arguments: { sessionId, selector: "#x" } })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toMatch(/provider instance is unavailable/)
    await cleanup()
  })
})

/**
 * Tests for the `transmit_message` MCP tool (orchestration-tools.ts WP2):
 * sends via `sendOutbound` (agentpush uses `send_message`, telegram uses
 * direct Bot API POST) and, by default, upserts a TransmitterBinding so
 * future inbound replies from the contact route into `sessionId`.
 */

import { describe, it, expect, vi } from "vitest"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"

import { registerOrchestrationTools } from "../orchestration-tools.js"
import { createSessionEventBus } from "../session-event-bus.js"
import { createEventRing } from "../event-ring.js"
import { createSessionsRegistry } from "../sessions.js"
import type { SessionsRegistry } from "../sessions.js"
import type { McpProxyRegistry } from "../mcp-proxy.js"
import type { ProxyCallOutcome } from "../mcp-proxy.js"
import type { TransmitterBinding, TransmitterBindingStore } from "../transmitter-bindings.js"
import type { TelegramBotCredsStore } from "../telegram-bot-creds.js"

function makeMockTelegramCreds(readValue: { token: string } | null): TelegramBotCredsStore {
  return {
    read: vi.fn().mockResolvedValue(readValue),
    write: vi.fn(),
    exists: vi.fn().mockResolvedValue(readValue !== null),
  }
}

interface ToolResult {
  isError?: boolean
  content?: Array<{ type: string; text?: string }>
}

function textOf(res: ToolResult): string {
  return res.content?.find(c => c.type === "text")?.text ?? ""
}

/** Minimal in-memory TransmitterBindingStore satisfying the frozen WP1 interface. */
function makeBindingStore(): TransmitterBindingStore {
  const map = new Map<string, TransmitterBinding>()
  const key = (alias: string, source: string, contactRef: string): string =>
    `${alias}:${source}:${contactRef}`

  return {
    get: (alias, source, contactRef) => map.get(key(alias, source, contactRef)),
    upsert: b => {
      const binding: TransmitterBinding = { ...b, lastSeenTs: b.lastSeenTs ?? 0 }
      map.set(key(b.alias, b.source, b.contactRef), binding)
      return binding
    },
    remove: (alias, source, contactRef) => map.delete(key(alias, source, contactRef)),
    list: () => Array.from(map.values()),
  }
}

async function connectTools(
  registry: SessionsRegistry,
  mcpProxy: McpProxyRegistry,
  bindingStore: TransmitterBindingStore,
  telegramCreds?: TelegramBotCredsStore,
): Promise<Client> {
  const server = new McpServer({ name: "transmit-message-test-server", version: "0.0.0" })
  registerOrchestrationTools(server, {
    registry,
    sessionEvents: createSessionEventBus(),
    eventRing: createEventRing(),
    mcpProxy,
    bindingStore,
    telegramCreds,
  })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "transmit-message-test-client", version: "0.0.0" })
  await client.connect(clientTransport)
  return client
}

describe("transmit_message", () => {
  it("agentpush provider calls send_message and binds by default", async () => {
    const callTool = vi.fn(
      async (): Promise<ProxyCallOutcome> => ({ ok: true, result: { content: [] } }),
    )
    const mcpProxy = { callTool } as unknown as McpProxyRegistry
    const bindingStore = makeBindingStore()
    const registry = createSessionsRegistry({ persist: false })

    const client = await connectTools(registry, mcpProxy, bindingStore)

    const res = (await client.callTool({
      name: "transmit_message",
      arguments: {
        provider: "agentpush",
        alias: "agentpush",
        source: "+33600000000",
        contact_ref: "alice",
        text: "hello alice",
        sessionId: "sess_1",
      },
    })) as ToolResult

    expect(res.isError).toBeFalsy()
    expect(callTool).toHaveBeenCalledWith("agentpush", "send_message", {
      to: { channel: "+33600000000", address: "alice" },
      content: { text: "hello alice" },
    })
    expect(JSON.parse(textOf(res))).toEqual({ sent: true, bound: true })

    const binding = bindingStore.get("agentpush", "+33600000000", "alice")
    expect(binding).toMatchObject({
      alias: "agentpush",
      source: "+33600000000",
      contactRef: "alice",
      sessionId: "sess_1",
      mode: "route-or-spawn",
      provider: "agentpush",
    })
  })

  it("agentpush provider defaults when provider omitted", async () => {
    const callTool = vi.fn(
      async (): Promise<ProxyCallOutcome> => ({ ok: true, result: { content: [] } }),
    )
    const mcpProxy = { callTool } as unknown as McpProxyRegistry
    const bindingStore = makeBindingStore()
    const registry = createSessionsRegistry({ persist: false })

    const client = await connectTools(registry, mcpProxy, bindingStore)

    const res = (await client.callTool({
      name: "transmit_message",
      arguments: {
        alias: "agentpush",
        source: "+33600000000",
        contact_ref: "alice",
        text: "hello alice",
        sessionId: "sess_1",
      },
    })) as ToolResult

    expect(res.isError).toBeFalsy()
    expect(callTool).toHaveBeenCalledWith("agentpush", "send_message", {
      to: { channel: "+33600000000", address: "alice" },
      content: { text: "hello alice" },
    })

    const binding = bindingStore.get("agentpush", "+33600000000", "alice")
    expect(binding?.provider).toBe("agentpush")
  })

  it("agentpush provider requires alias", async () => {
    const callTool = vi.fn(
      async (): Promise<ProxyCallOutcome> => ({ ok: true, result: { content: [] } }),
    )
    const mcpProxy = { callTool } as unknown as McpProxyRegistry
    const bindingStore = makeBindingStore()
    const registry = createSessionsRegistry({ persist: false })

    const client = await connectTools(registry, mcpProxy, bindingStore)

    const res = (await client.callTool({
      name: "transmit_message",
      arguments: {
        provider: "agentpush",
        source: "+33600000000",
        contact_ref: "alice",
        text: "hello alice",
        sessionId: "sess_1",
      },
    })) as ToolResult

    expect(res.isError).toBe(true)
    expect(JSON.parse(textOf(res))).toMatchObject({
      sent: false,
      error: expect.stringContaining("alias required"),
    })
    expect(callTool).not.toHaveBeenCalled()
  })

  it("telegram provider sends via Bot API and binds by default", async () => {
    const globalFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: { message_id: 42 } }),
    } as unknown as Response)
    vi.stubGlobal("fetch", globalFetch)

    const telegramCreds = makeMockTelegramCreds({ token: "test-token-123" })
    const callTool = vi.fn()
    const mcpProxy = { callTool } as unknown as McpProxyRegistry
    const bindingStore = makeBindingStore()
    const registry = createSessionsRegistry({ persist: false })

    const client = await connectTools(registry, mcpProxy, bindingStore, telegramCreds)

    const res = (await client.callTool({
      name: "transmit_message",
      arguments: {
        provider: "telegram",
        source: "123456789",
        contact_ref: "123456789",
        text: "hello from telegram",
        sessionId: "sess_tg",
      },
    })) as ToolResult

    expect(res.isError).toBeFalsy()
    expect(telegramCreds.read).toHaveBeenCalledWith("default")
    expect(globalFetch).toHaveBeenCalledWith(
      "https://api.telegram.org/bottest-token-123/sendMessage",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: "123456789", text: "hello from telegram" }),
      },
    )
    expect(callTool).not.toHaveBeenCalled()
    expect(JSON.parse(textOf(res))).toEqual({ sent: true, bound: true })

    const binding = bindingStore.get("default", "123456789", "123456789")
    expect(binding).toMatchObject({
      alias: "default",
      source: "123456789",
      contactRef: "123456789",
      sessionId: "sess_tg",
      mode: "route-or-spawn",
      provider: "telegram",
    })

    vi.unstubAllGlobals()
  })

  it("telegram provider uses custom alias for token selection", async () => {
    const globalFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: { message_id: 99 } }),
    } as unknown as Response)
    vi.stubGlobal("fetch", globalFetch)

    const telegramCreds = makeMockTelegramCreds({ token: "custom-token" })
    const mcpProxy = { callTool: vi.fn() } as unknown as McpProxyRegistry
    const bindingStore = makeBindingStore()
    const registry = createSessionsRegistry({ persist: false })

    const client = await connectTools(registry, mcpProxy, bindingStore, telegramCreds)

    const res = (await client.callTool({
      name: "transmit_message",
      arguments: {
        provider: "telegram",
        alias: "mybot",
        source: "987654321",
        contact_ref: "987654321",
        text: "hi",
        sessionId: "sess_tg2",
      },
    })) as ToolResult

    expect(res.isError).toBeFalsy()
    expect(telegramCreds.read).toHaveBeenCalledWith("mybot")
    expect(globalFetch).toHaveBeenCalledWith(
      "https://api.telegram.org/botcustom-token/sendMessage",
      expect.any(Object),
    )

    const binding = bindingStore.get("mybot", "987654321", "987654321")
    expect(binding?.provider).toBe("telegram")

    vi.unstubAllGlobals()
  })

  it("telegram provider surfaces missing creds as error", async () => {
    const mcpProxy = { callTool: vi.fn() } as unknown as McpProxyRegistry
    const bindingStore = makeBindingStore()
    const registry = createSessionsRegistry({ persist: false })

    const client = await connectTools(registry, mcpProxy, bindingStore)

    const res = (await client.callTool({
      name: "transmit_message",
      arguments: {
        provider: "telegram",
        source: "123",
        contact_ref: "123",
        text: "hi",
        sessionId: "sess_tg",
      },
    })) as ToolResult

    expect(res.isError).toBe(true)
    expect(JSON.parse(textOf(res))).toMatchObject({
      sent: false,
      error: "telegram_creds_not_configured",
    })
  })

  it("bind:false sends without upserting a binding", async () => {
    const callTool = vi.fn(
      async (): Promise<ProxyCallOutcome> => ({ ok: true, result: { content: [] } }),
    )
    const mcpProxy = { callTool } as unknown as McpProxyRegistry
    const bindingStore = makeBindingStore()
    const registry = createSessionsRegistry({ persist: false })

    const client = await connectTools(registry, mcpProxy, bindingStore)

    const res = (await client.callTool({
      name: "transmit_message",
      arguments: {
        alias: "agentpush",
        source: "+33600000000",
        contact_ref: "bob",
        text: "hi bob",
        sessionId: "sess_2",
        bind: false,
      },
    })) as ToolResult

    expect(res.isError).toBeFalsy()
    expect(JSON.parse(textOf(res))).toEqual({ sent: true, bound: false })
    expect(bindingStore.get("agentpush", "+33600000000", "bob")).toBeUndefined()
  })

  it("surfaces a send failure as an error without binding", async () => {
    const callTool = vi.fn(
      async (): Promise<ProxyCallOutcome> => ({ ok: false, error: "upstream down" }),
    )
    const mcpProxy = { callTool } as unknown as McpProxyRegistry
    const bindingStore = makeBindingStore()
    const registry = createSessionsRegistry({ persist: false })

    const client = await connectTools(registry, mcpProxy, bindingStore)

    const res = (await client.callTool({
      name: "transmit_message",
      arguments: {
        alias: "agentpush",
        source: "+33600000000",
        contact_ref: "carol",
        text: "hi carol",
        sessionId: "sess_3",
      },
    })) as ToolResult

    expect(res.isError).toBe(true)
    expect(bindingStore.get("agentpush", "+33600000000", "carol")).toBeUndefined()
  })

  it("is not registered when mcpProxy/bindingStore are absent", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const server = new McpServer({ name: "no-transmit-server", version: "0.0.0" })
    registerOrchestrationTools(server, {
      registry,
      sessionEvents: createSessionEventBus(),
      eventRing: createEventRing(),
    })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const client = new Client({ name: "no-transmit-client", version: "0.0.0" })
    await client.connect(clientTransport)

    const tools = await client.listTools()
    expect(tools.tools.map(t => t.name)).not.toContain("transmit_message")
  })
})

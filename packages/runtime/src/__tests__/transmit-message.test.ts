/**
 * Tests for the `transmit_message` MCP tool (orchestration-tools.ts WP2):
 * sends via `mcpProxy.callTool(alias, "dispatch_request", ...)` and, by
 * default, upserts a TransmitterBinding so future inbound replies from the
 * contact route into `sessionId`.
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
): Promise<Client> {
  const server = new McpServer({ name: "transmit-message-test-server", version: "0.0.0" })
  registerOrchestrationTools(server, {
    registry,
    sessionEvents: createSessionEventBus(),
    eventRing: createEventRing(),
    mcpProxy,
    bindingStore,
  })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "transmit-message-test-client", version: "0.0.0" })
  await client.connect(clientTransport)
  return client
}

describe("transmit_message", () => {
  it("sends via mcpProxy.callTool(alias, dispatch_request, ...) and binds by default", async () => {
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
    expect(callTool).toHaveBeenCalledWith("agentpush", "dispatch_request", {
      source: "+33600000000",
      contact_ref: "alice",
      text: "hello alice",
    })
    expect(JSON.parse(textOf(res))).toEqual({ sent: true, bound: true })

    const binding = bindingStore.get("agentpush", "+33600000000", "alice")
    expect(binding).toMatchObject({
      alias: "agentpush",
      source: "+33600000000",
      contactRef: "alice",
      sessionId: "sess_1",
      mode: "route-or-spawn",
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

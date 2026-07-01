/**
 * Unit tests for the per-session notifyUrl lifecycle in registerSessionTools.
 *
 * Proves:
 *   (a) start_agent_session with notifyUrl calls webhookNotifier.register(sessionId, url)
 *   (b) a session:exited event (wired the same way index.ts does) calls
 *       webhookNotifier.unregister(sessionId) — preventing map leaks.
 */

import { describe, it, expect, vi } from "vitest"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { createMcpServer } from "@agentproto/mcp-server"

import { registerSessionTools } from "../session-tools.js"
import { createSessionsRegistry } from "../sessions.js"
import { createSessionEventBus } from "../session-event-bus.js"
import type { AgentSessionLike, AgentStreamEvent } from "../sessions.js"
import type { AgentAdapterResolver } from "../http-server.js"
import type { WebhookNotifier } from "../webhook-notifier.js"

let acpCounter = 0
function fakeAgentSession(): AgentSessionLike {
  return {
    sessionId: `acp_notify_${acpCounter++}`,
    // eslint-disable-next-line require-yield
    async *send(): AsyncIterable<AgentStreamEvent> {
      return
    },
    async cancel() {},
    async close() {},
  }
}

function makeResolver(): AgentAdapterResolver {
  return async () => ({
    async startSession() {
      return fakeAgentSession()
    },
    commandPreview: "mock-adapter",
  })
}

function makeNotifierSpy(): WebhookNotifier {
  return {
    register: vi.fn(),
    unregister: vi.fn(),
    onSessionEvent: vi.fn(),
  }
}

async function buildHarness(notifier: WebhookNotifier) {
  const sessionEvents = createSessionEventBus()
  // Mirror the wiring in createGateway (index.ts): unregister per-session URL
  // on exit so the notifier map doesn't leak across sessions.
  sessionEvents.on("session:exited", ev => {
    notifier.unregister(ev.sessionId)
  })

  const registry = createSessionsRegistry({ sessionEvents, persist: false })
  const { server } = await createMcpServer({ specs: [], name: "test", version: "0" })

  registerSessionTools(server, {
    registry,
    resolveAgentAdapter: makeResolver(),
    webhookNotifier: notifier,
  })

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "test-client", version: "0" })
  await client.connect(clientTransport)

  return { client, registry, sessionEvents, close: () => client.close() }
}

describe("agent_start — notifyUrl register/unregister lifecycle", () => {
  it("(a) register(sessionId, url) is called on spawn when notifyUrl is provided", async () => {
    const notifier = makeNotifierSpy()
    const { client, close } = await buildHarness(notifier)

    const result = await client.callTool({
      name: "agent_start",
      arguments: {
        adapter: "claude-code",
        cwd: process.cwd(),
        notifyUrl: "https://example.com/hook",
      },
    })

    // Extract the spawned sessionId from the tool response.
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? ""
    const desc = JSON.parse(text) as { id: string }

    expect(notifier.register).toHaveBeenCalledOnce()
    expect(notifier.register).toHaveBeenCalledWith(desc.id, "https://example.com/hook")

    await close()
  })

  it("(b) unregister(sessionId) is called when session:exited fires", async () => {
    const notifier = makeNotifierSpy()
    const { client, registry, sessionEvents, close } = await buildHarness(notifier)

    const result = await client.callTool({
      name: "agent_start",
      arguments: {
        adapter: "claude-code",
        cwd: process.cwd(),
        notifyUrl: "https://example.com/hook",
      },
    })

    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? ""
    const desc = JSON.parse(text) as { id: string }

    // Simulate session exit — mirrors what the sessions registry does on process close.
    sessionEvents.emit({
      type: "session:exited",
      sessionId: desc.id,
      status: "exited",
      ts: new Date().toISOString(),
    })

    expect(notifier.unregister).toHaveBeenCalledOnce()
    expect(notifier.unregister).toHaveBeenCalledWith(desc.id)

    // register should not have been called a second time.
    expect(notifier.register).toHaveBeenCalledOnce()

    await close()
    registry.shutdown()
  })

  it("(c) register is NOT called when notifyUrl is omitted", async () => {
    const notifier = makeNotifierSpy()
    const { client, close } = await buildHarness(notifier)

    await client.callTool({
      name: "agent_start",
      arguments: {
        adapter: "claude-code",
        cwd: process.cwd(),
      },
    })

    expect(notifier.register).not.toHaveBeenCalled()

    await close()
  })
})

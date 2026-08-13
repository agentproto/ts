/**
 * Unit tests for the `session_flag_status` MCP tool (session-tools.ts) — the
 * ingress layer over `SessionsRegistry.flagAwaitingInput` (registry-level
 * guard/persist/event behaviour is covered in session-flag-status.test.ts).
 * Mirrors session-archive-mcp.test.ts's harness.
 */

import { describe, it, expect } from "vitest"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { createMcpServer } from "@agentproto/mcp-server"

import { registerSessionTools } from "../session-tools.js"
import { createSessionsRegistry } from "../sessions.js"
import { createSessionEventBus } from "../session-event-bus.js"
import type { SessionEvent, SessionEventBus } from "../session-event-bus.js"
import type { AgentSessionLike, AgentStreamEvent, SessionsRegistry } from "../sessions.js"

let acpCounter = 0
function fakeAgentSession(prefix: string): AgentSessionLike {
  return {
    sessionId: `${prefix}_${acpCounter++}`,
    // eslint-disable-next-line require-yield
    async *send(): AsyncIterable<AgentStreamEvent> {
      return
    },
    async cancel() {},
    async close() {},
  }
}

async function buildHarness(): Promise<{
  client: Client
  registry: SessionsRegistry
  sessionEvents: SessionEventBus
  close: () => Promise<void>
}> {
  const sessionEvents = createSessionEventBus()
  const registry = createSessionsRegistry({ sessionEvents, persist: false })
  const { server } = await createMcpServer({ specs: [], name: "test", version: "0" })
  registerSessionTools(server, { registry })

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "test-client", version: "0" })
  await client.connect(clientTransport)

  return { client, registry, sessionEvents, close: () => client.close() }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toolJson(result: any): Record<string, unknown> {
  const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "{}"
  return JSON.parse(text)
}

describe("session_flag_status", () => {
  it("sets awaitingInput true with a question on a live session", async () => {
    const { client, registry, close } = await buildHarness()
    const prev = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: process.cwd(),
      agentSession: fakeAgentSession("claude"),
      adapterSlug: "claude-code",
    })

    const result = await client.callTool({
      name: "session_flag_status",
      arguments: {
        idOrName: prev.id,
        awaitingInput: true,
        question: "Which environment should I deploy to?",
        reason: "heuristic missed a real question buried in tool output",
      },
    })
    expect(result.isError).toBeFalsy()
    const body = toolJson(result)
    expect(body.awaitingInput).toBe(true)
    expect(body.awaitingQuestion).toEqual({
      text: "Which environment should I deploy to?",
      source: "structured",
    })

    await close()
    registry.shutdown()
  })

  it("clears a false positive and drops any prior awaitingQuestion", async () => {
    const { client, registry, close } = await buildHarness()
    const prev = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: process.cwd(),
      agentSession: fakeAgentSession("claude"),
      adapterSlug: "claude-code",
    })
    await client.callTool({
      name: "session_flag_status",
      arguments: {
        idOrName: prev.id,
        awaitingInput: true,
        question: "Continue?",
        reason: "seed a question",
      },
    })

    const result = await client.callTool({
      name: "session_flag_status",
      arguments: {
        idOrName: prev.id,
        awaitingInput: false,
        reason: "false positive — session was narrating, not asking",
      },
    })
    expect(result.isError).toBeFalsy()
    const body = toolJson(result)
    expect(body.awaitingInput).toBe(false)
    expect(body.awaitingQuestion).toBeUndefined()

    await close()
    registry.shutdown()
  })

  it("rejects a question attached to awaitingInput:false", async () => {
    const { client, registry, close } = await buildHarness()
    const prev = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: process.cwd(),
      agentSession: fakeAgentSession("claude"),
      adapterSlug: "claude-code",
    })

    const result = await client.callTool({
      name: "session_flag_status",
      arguments: {
        idOrName: prev.id,
        awaitingInput: false,
        question: "This should not be allowed",
        reason: "invalid combination",
      },
    })
    expect(result.isError).toBe(true)
    expect(registry.get(prev.id)?.awaitingInput).toBeUndefined()

    await close()
    registry.shutdown()
  })

  it("refuses a terminal-status session with a clear error", async () => {
    const { client, registry, close } = await buildHarness()
    const prev = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: process.cwd(),
      agentSession: fakeAgentSession("claude"),
      adapterSlug: "claude-code",
    })
    registry.kill(prev.id)

    const result = await client.callTool({
      name: "session_flag_status",
      arguments: { idOrName: prev.id, awaitingInput: true, reason: "test" },
    })
    expect(result.isError).toBe(true)
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? ""
    expect(text).toMatch(/not live/)
    expect(registry.get(prev.id)?.awaitingInput).toBeUndefined()

    await close()
    registry.shutdown()
  })

  it("errors on an unknown session id", async () => {
    const { client, close, registry } = await buildHarness()
    const result = await client.callTool({
      name: "session_flag_status",
      arguments: { idOrName: "sess_nope", awaitingInput: true, reason: "test" },
    })
    expect(result.isError).toBe(true)
    await close()
    registry.shutdown()
  })

  it("emits session:awaiting-input-flagged on the shared session-event bus " +
    "(the same bus session_events_poll's EventRing wires generically) with " +
    "the caller's reason", async () => {
    const { client, registry, sessionEvents, close } = await buildHarness()
    const events: SessionEvent[] = []
    sessionEvents.onAny(ev => events.push(ev))
    const prev = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: process.cwd(),
      agentSession: fakeAgentSession("claude"),
      adapterSlug: "claude-code",
    })

    await client.callTool({
      name: "session_flag_status",
      arguments: {
        idOrName: prev.id,
        awaitingInput: true,
        question: "Ship it?",
        reason: "manual correction for the event-visibility test",
      },
    })

    const flagged = events.find(e => e.type === "session:awaiting-input-flagged")
    expect(flagged).toMatchObject({
      type: "session:awaiting-input-flagged",
      sessionId: prev.id,
      awaitingInput: true,
      reason: "manual correction for the event-visibility test",
      question: { text: "Ship it?", source: "structured" },
    })

    await close()
    registry.shutdown()
  })
})

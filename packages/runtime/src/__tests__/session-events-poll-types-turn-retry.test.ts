/**
 * `session_events_poll`'s hard-coded `types` filter must know every directly
 * named bus event — otherwise input validation rejects a type the ring
 * happily returns unfiltered, and a client cannot subscribe to it at all
 * (the `session:turn-retry` observability event is the case in point).
 *
 * Drives the REAL `session_events_poll` MCP handler via
 * `registerOrchestrationTools`, against a real registry and the production
 * bus→ring wiring (`EventRing.wire`).
 */

import { describe, it, expect } from "vitest"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"

import { registerOrchestrationTools } from "../orchestration-tools.js"
import { createSessionEventBus } from "../session-event-bus.js"
import { createEventRing } from "../event-ring.js"
import { createSessionsRegistry } from "../sessions.js"
import type { AgentSessionLike, AgentStreamEvent } from "../sessions.js"

function fakeAgentSession(): AgentSessionLike {
  return {
    sessionId: "acp_fake",
    // eslint-disable-next-line require-yield
    async *send(): AsyncIterable<AgentStreamEvent> {
      return
    },
    async cancel() {},
    async close() {},
  }
}

/** A client over the real `session_events_poll` handler. */
async function pollClient(): Promise<{ client: Client; sessionId: string }> {
  const registry = createSessionsRegistry({ persist: false })
  const desc = registry.spawnAgent({
    workspaceSlug: "w",
    cwd: "/tmp",
    agentSession: fakeAgentSession(),
    adapterSlug: "mock",
  })
  const bus = createSessionEventBus()
  const ring = createEventRing()
  ring.wire(bus)
  bus.emit({
    type: "session:turn-end",
    sessionId: desc.id,
    awaitingInput: false,
    reason: "error",
    error: "429 status code",
    ts: new Date().toISOString(),
  })
  bus.emit({
    type: "session:turn-retry",
    sessionId: desc.id,
    phase: "scheduled",
    errorClass: "rate-limit",
    attempt: 1,
    maxRetries: 3,
    delayMs: 5000,
    ts: new Date().toISOString(),
  })
  bus.emit({
    type: "mcp:degraded",
    sessionId: desc.id,
    server: "daemon",
    reason: "never-listed",
    ts: new Date().toISOString(),
  })
  const server = new McpServer({ name: "events-types-server", version: "0.0.0" })
  registerOrchestrationTools(server, {
    registry,
    sessionEvents: createSessionEventBus(),
    eventRing: ring,
  })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "events-types-client", version: "0.0.0" })
  await client.connect(clientTransport)
  return { client, sessionId: desc.id }
}

interface PollResult {
  events: { type: string; sessionId?: string }[]
  nextCursor: number
}

async function poll(client: Client, args: Record<string, unknown>): Promise<PollResult> {
  const result = await client.callTool({ name: "session_events_poll", arguments: args })
  const blocks = "content" in result ? result.content : undefined
  if (!Array.isArray(blocks)) throw new Error("tool result has no content array")
  for (const block of blocks) {
    if (typeof block === "object" && block !== null && "text" in block && typeof block.text === "string") {
      return JSON.parse(block.text) as PollResult
    }
  }
  throw new Error("tool returned no text content")
}

describe("session_events_poll — types filter covers turn-retry", () => {
  it("returns the turn-retry event unfiltered", async () => {
    const { client } = await pollClient()
    expect((await poll(client, { since: 0 })).events.map(e => e.type).sort()).toEqual([
      "mcp:degraded",
      "session:turn-end",
      "session:turn-retry",
    ])
    await client.close()
  })

  it("accepts types: ['session:turn-retry'] and filters to it", async () => {
    const { client, sessionId } = await pollClient()
    const filtered = await poll(client, { since: 0, types: ["session:turn-retry"] })
    expect(filtered.events.map(e => e.type)).toEqual(["session:turn-retry"])
    expect(filtered.events.map(e => e.sessionId)).toEqual([sessionId])
    await client.close()
  })

  it("other type filters still narrow the same snapshot", async () => {
    const { client } = await pollClient()
    expect((await poll(client, { since: 0, types: ["mcp:degraded"] })).events.map(e => e.type)).toEqual([
      "mcp:degraded",
    ])
    const both = await poll(client, { since: 0, types: ["session:turn-retry", "mcp:degraded"] })
    expect(both.events.map(e => e.type).sort()).toEqual(["mcp:degraded", "session:turn-retry"])
    await client.close()
  })
})

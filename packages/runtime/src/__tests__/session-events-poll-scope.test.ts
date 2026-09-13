/**
 * `session_events_poll` subtree scoping (WP6): a scoped child orchestrator
 * polling events must only see lifecycle events for sessions inside its own
 * subtree — never for a stranger spawned outside it. Mirrors the scoping the
 * sibling tools in `orchestration-tools.ts` (`policy_list`, `policy_attach`,
 * `policy_cancel`, `permissions_list`) already apply.
 *
 * Drives the REAL `session_events_poll` MCP handler via
 * `registerOrchestrationTools`, against a real registry whose parent→child
 * graph `collectSubtree` walks. The bus→ring wiring is the production one
 * (`EventRing.wire`); the filter under test is the handler's, not the ring's.
 */

import { describe, it, expect } from "vitest"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"

import { registerOrchestrationTools } from "../orchestration-tools.js"
import { createSessionEventBus } from "../session-event-bus.js"
import type { SessionEventBus } from "../session-event-bus.js"
import { createEventRing } from "../event-ring.js"
import type { EventRing } from "../event-ring.js"
import { createSessionsRegistry, type SessionsRegistry } from "../sessions.js"
import type { AgentSessionLike, AgentStreamEvent, SessionDescriptor } from "../sessions.js"

// ── Fixtures ──────────────────────────────────────────────────────────

let acpCounter = 0
/** A fake ACP session — never receives turns here; it exists so the registry
 *  holds real descriptors for `collectSubtree` to walk. */
function fakeAgentSession(): AgentSessionLike {
  return {
    sessionId: `acp_${acpCounter++}`,
    // eslint-disable-next-line require-yield
    async *send(): AsyncIterable<AgentStreamEvent> {
      return
    },
    async cancel() {},
    async close() {},
  }
}

function spawnNode(
  registry: SessionsRegistry,
  parentSessionId?: string,
  depth = 0,
): SessionDescriptor {
  return registry.spawnAgent({
    workspaceSlug: "w",
    cwd: "/tmp",
    agentSession: fakeAgentSession(),
    adapterSlug: "mock",
    ...(parentSessionId ? { parentSessionId } : {}),
    depth,
  })
}

function turnEnd(sessionId: string) {
  return {
    type: "session:turn-end" as const,
    sessionId,
    awaitingInput: false,
    ts: new Date().toISOString(),
  }
}

/** Text of an MCP content block, or undefined if it isn't a text block. */
function blockText(block: unknown): string | undefined {
  if (typeof block !== "object" || block === null) return undefined
  if (!("type" in block) || block.type !== "text") return undefined
  if (!("text" in block) || typeof block.text !== "string") return undefined
  return block.text
}

/** The SDK's own result type — a union whose legacy `{ toolResult }` branch
 *  carries no content, hence the `in` narrow below. */
type CallToolResult = Awaited<ReturnType<Client["callTool"]>>

interface PollResult {
  events: { type: string; sessionId?: string }[]
  nextCursor: number
}

function parseToolJson(result: CallToolResult): PollResult {
  const blocks = "content" in result ? result.content : undefined
  if (!Array.isArray(blocks)) throw new Error("tool result has no content array")
  for (const block of blocks) {
    const text = blockText(block)
    if (text === undefined) continue
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== "object" || parsed === null || !("events" in parsed)) {
      throw new Error(`session_events_poll returned unexpected shape: ${text}`)
    }
    return parsed as PollResult
  }
  throw new Error("tool returned no text content")
}

/** Registry holding `owner → child`, plus an unrelated `stranger`. Every
 *  session has a turn-end event already pushed through the ring. */
function fixture(): {
  registry: SessionsRegistry
  bus: SessionEventBus
  ring: EventRing
  ownerId: string
  childId: string
  strangerId: string
} {
  const registry = createSessionsRegistry({ persist: false })
  const owner = spawnNode(registry)
  const child = spawnNode(registry, owner.id, 1)
  const stranger = spawnNode(registry)
  const bus = createSessionEventBus()
  const ring = createEventRing()
  ring.wire(bus)
  for (const id of [owner.id, child.id, stranger.id]) {
    bus.emit(turnEnd(id))
  }
  return { registry, bus, ring, ownerId: owner.id, childId: child.id, strangerId: stranger.id }
}

/** Build a client over the real `session_events_poll` handler. */
async function mcpClient(opts: {
  registry: SessionsRegistry
  ring: EventRing
  callerScope?: { ownerSessionId?: string }
}): Promise<Client> {
  const server = new McpServer({ name: "events-scope-server", version: "0.0.0" })
  registerOrchestrationTools(server, {
    registry: opts.registry,
    sessionEvents: createSessionEventBus(),
    eventRing: opts.ring,
    ...(opts.callerScope ? { callerScope: opts.callerScope } : {}),
  })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "events-scope-client", version: "0.0.0" })
  await client.connect(clientTransport)
  return client
}

async function poll(client: Client, args: Record<string, unknown> = {}): Promise<PollResult> {
  return parseToolJson(await client.callTool({ name: "session_events_poll", arguments: args }))
}

const eventSessionIds = (r: PollResult): string[] =>
  r.events.map(e => e.sessionId).filter((s): s is string => typeof s === "string")

// ── session_events_poll subtree scoping ───────────────────────────────

describe("session_events_poll — subtree scoping", () => {
  it("an unscoped (root/operator) caller still sees every event — behaviour unchanged", async () => {
    const f = fixture()
    const client = await mcpClient({ registry: f.registry, ring: f.ring })
    expect(eventSessionIds(await poll(client, { since: 0 })).sort()).toEqual(
      [f.ownerId, f.childId, f.strangerId].sort(),
    )
    await client.close()
  })

  it("a scoped caller CAN see events for sessions in its own subtree (owner + child)", async () => {
    const f = fixture()
    const client = await mcpClient({
      registry: f.registry,
      ring: f.ring,
      callerScope: { ownerSessionId: f.ownerId },
    })
    expect(eventSessionIds(await poll(client, { since: 0 })).sort()).toEqual(
      [f.ownerId, f.childId].sort(),
    )
    await client.close()
  })

  it("a scoped caller CANNOT see events for a session outside its subtree (regression)", async () => {
    const f = fixture()
    const client = await mcpClient({
      registry: f.registry,
      ring: f.ring,
      callerScope: { ownerSessionId: f.ownerId },
    })
    const sessions = eventSessionIds(await poll(client, { since: 0 }))
    expect(sessions).not.toContain(f.strangerId)
    // And the sessionIds filter cannot reach around the boundary either.
    expect(eventSessionIds(await poll(client, { since: 0, sessionIds: [f.strangerId] }))).toEqual([])
    await client.close()
  })

  it("a scoped caller's sessionIds filter still narrows within its own subtree", async () => {
    const f = fixture()
    const client = await mcpClient({
      registry: f.registry,
      ring: f.ring,
      callerScope: { ownerSessionId: f.ownerId },
    })
    expect(eventSessionIds(await poll(client, { since: 0, sessionIds: [f.childId] }))).toEqual([f.childId])
    await client.close()
  })

  it("an unbound scope (callerScope present, no ownerSessionId) sees no session events", async () => {
    const f = fixture()
    const client = await mcpClient({
      registry: f.registry,
      ring: f.ring,
      callerScope: {},
    })
    expect(eventSessionIds(await poll(client, { since: 0 }))).toEqual([])
    await client.close()
  })
})

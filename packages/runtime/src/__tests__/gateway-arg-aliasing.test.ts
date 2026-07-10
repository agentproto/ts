/**
 * Gateway argument-name aliasing.
 *
 * `agent_start` returns the session as `{ id }`, but the drive tools
 * historically required `sessionId`, and `session_monitor` required a
 * `sessionIds` array. Passing the natural `{ id }` shape straight back
 * failed with a Zod error — a failed call per tool just to learn the
 * field name. These tools now accept the shapes additively:
 *   - agent_prompt / agent_output / agent_kill / agent_export → `sessionId`
 *     OR its alias `id`
 *   - session_monitor → `sessionIds` (array OR a single string) OR
 *     `sessionId` OR `id`
 * and still reject when NO session id is supplied.
 */

import { describe, it, expect, vi } from "vitest"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"

import { registerAgentTools } from "../agent-tools.js"
import { registerOrchestrationTools } from "../orchestration-tools.js"
import { createSessionEventBus } from "../session-event-bus.js"
import { createEventRing } from "../event-ring.js"
import {
  createSessionsRegistry,
  type AgentSessionLike,
} from "../sessions.js"
import type { SessionsRegistry, SessionDescriptor } from "../sessions.js"

interface ToolResult {
  isError?: boolean
  content?: Array<{ type: string; text?: string }>
}

function textOf(res: ToolResult): string {
  return res.content?.find(c => c.type === "text")?.text ?? ""
}

function instantAgentSession(): AgentSessionLike {
  return {
    sessionId: "instant-session",
    async *send() {
      yield { kind: "turn-end", reason: "completed" }
    },
    async cancel() {},
    async close() {},
  }
}

async function connectAgentTools(registry: SessionsRegistry): Promise<Client> {
  const server = new McpServer({ name: "alias-agent-server", version: "0.0.0" })
  registerAgentTools(server, { registry })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "alias-agent-client", version: "0.0.0" })
  await client.connect(clientTransport)
  return client
}

describe("agent drive tools accept `id` as an alias for `sessionId`", () => {
  it("agent_output resolves via `id`, via `sessionId`, and errors when neither is given", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: instantAgentSession(),
      adapterSlug: "fake",
    })
    const client = await connectAgentTools(registry)

    // Alias form — the exact shape agent_start returns.
    const viaId = (await client.callTool({
      name: "agent_output",
      arguments: { id: desc.id },
    })) as ToolResult
    expect(viaId.isError).toBeFalsy()
    expect(JSON.parse(textOf(viaId)).sessionId).toBe(desc.id)

    // Back-compat form.
    const viaSessionId = (await client.callTool({
      name: "agent_output",
      arguments: { sessionId: desc.id },
    })) as ToolResult
    expect(viaSessionId.isError).toBeFalsy()
    expect(JSON.parse(textOf(viaSessionId)).sessionId).toBe(desc.id)

    // Neither → a clear error, not a silent no-op.
    const missing = (await client.callTool({
      name: "agent_output",
      arguments: {},
    })) as ToolResult
    expect(missing.isError).toBe(true)
    expect(textOf(missing)).toContain("missing session id")

    registry.shutdown()
  })

  it("agent_kill resolves a live session via `id`", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: instantAgentSession(),
      adapterSlug: "fake",
    })
    const client = await connectAgentTools(registry)

    const res = (await client.callTool({
      name: "agent_kill",
      arguments: { id: desc.id },
    })) as ToolResult
    expect(res.isError).toBeFalsy()
    const body = JSON.parse(textOf(res))
    expect(body.sessionId).toBe(desc.id)
    expect(body.ok).toBe(true)

    registry.shutdown()
  })
})

// ── session_monitor coalescing ─────────────────────────────────────────────
const QUESTION = {
  text: "Which environment should I target?",
  options: ["staging", "production"],
  source: "heuristic" as const,
}

function awaitingRegistry(): SessionsRegistry {
  const desc: SessionDescriptor = {
    id: "sess_awaiting",
    kind: "agent-cli",
    workspaceSlug: "test",
    command: "mock",
    pid: null,
    status: "running",
    startedAt: new Date().toISOString(),
    awaitingInput: true,
    awaitingQuestion: QUESTION,
  }
  return {
    get: vi.fn((id: string) => (id === "sess_awaiting" ? desc : undefined)),
    findByIdOrName: vi.fn((q: string) => (q === "sess_awaiting" ? desc : undefined)),
    list: vi.fn(() => [desc]),
  } as unknown as SessionsRegistry
}

async function connectMonitor(registry: SessionsRegistry): Promise<Client> {
  const server = new McpServer({ name: "alias-monitor-server", version: "0.0.0" })
  registerOrchestrationTools(server, {
    registry,
    sessionEvents: createSessionEventBus(),
    eventRing: createEventRing(),
  })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "alias-monitor-client", version: "0.0.0" })
  await client.connect(clientTransport)
  return client
}

describe("session_monitor accepts single-id and string shapes", () => {
  it.each([
    ["sessionIds array", { sessionIds: ["sess_awaiting"] }],
    ["sessionIds single string", { sessionIds: "sess_awaiting" }],
    ["sessionId singular", { sessionId: "sess_awaiting" }],
    ["id alias", { id: "sess_awaiting" }],
  ])("resolves the awaiting-input hit via %s", async (_label, args) => {
    const client = await connectMonitor(awaitingRegistry())
    const res = (await client.callTool({
      name: "session_monitor",
      arguments: { ...args, event: "awaiting-input" },
    })) as ToolResult
    expect(res.isError).toBeFalsy()
    const body = JSON.parse(textOf(res))
    expect(body.sessionId).toBe("sess_awaiting")
    expect(body.event).toBe("awaiting-input")
  })

  it("errors when no session id is supplied in any shape", async () => {
    const client = await connectMonitor(awaitingRegistry())
    const res = (await client.callTool({
      name: "session_monitor",
      arguments: { event: "awaiting-input" },
    })) as ToolResult
    expect(res.isError).toBe(true)
    expect(textOf(res)).toContain("no sessions to watch")
  })
})

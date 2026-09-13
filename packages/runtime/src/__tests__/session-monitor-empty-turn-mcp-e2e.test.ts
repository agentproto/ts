/**
 * End-to-end (real MCP transport) coverage for the `session_monitor` fail-
 * loud behaviour on a silent no-op turn — the bug-2 fix in
 * `monitorSessionWait` (see monitor-session-wait-turn-outcome.test.ts for
 * the data-propagation unit coverage). Mirrors the precedent already set by
 * `sessions-registry-agent-host.ts`'s `waitTurnEnd` /
 * `agent-host-empty-turn.test.ts`: a caller must not read a bare
 * "turn-end: success" as real progress when the turn produced nothing.
 */

import { describe, it, expect, vi } from "vitest"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"

import { registerOrchestrationTools } from "../orchestration-tools.js"
import { createSessionEventBus } from "../session-event-bus.js"
import { createEventRing } from "../event-ring.js"
import type { SessionsRegistry, SessionDescriptor } from "../sessions.js"

function makeRegistry(descs: Record<string, SessionDescriptor>): SessionsRegistry {
  return {
    get: vi.fn((id: string) => descs[id]),
    findByIdOrName: vi.fn((q: string) => descs[q]),
    incWatchers: vi.fn(),
    decWatchers: vi.fn(),
    spawn: vi.fn(),
    register: vi.fn(),
    spawnAgent: vi.fn(),
    spawnPty: vi.fn(),
    sendPrompt: vi.fn(async () => {}),
    enqueuePrompt: vi.fn(),
    list: vi.fn(() => Object.values(descs)),
    attach: vi.fn(() => null),
    attachPty: vi.fn(() => null),
    writeTerminalInput: vi.fn(() => false),
    readTerminalOutput: vi.fn(async () => ({ lines: [], nextCursor: 0 })),
    tailLines: vi.fn(async () => ({ lines: [], nextCursor: 0, skipped: 0 })),
    kill: vi.fn(),
    forget: vi.fn(),
    shutdown: vi.fn(),
  } as unknown as SessionsRegistry
}

async function connectedClient(registry: SessionsRegistry) {
  const bus = createSessionEventBus()
  const eventRing = createEventRing()
  const server = new McpServer({ name: "empty-turn-e2e-server", version: "0.0.0" })
  registerOrchestrationTools(server, { registry, sessionEvents: bus, eventRing })

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "empty-turn-e2e-client", version: "0.0.0" })
  await client.connect(clientTransport)
  return { client, bus, eventRing }
}

function parseToolJson(result: unknown): any {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content
  const text = content?.find(c => c.type === "text")?.text
  if (!text) throw new Error("tool returned no text content")
  return JSON.parse(text)
}

describe("session_monitor — fails loud on a silent no-op turn (MCP e2e)", () => {
  it("empty: true → isError: true with an actionable message", async () => {
    const desc: SessionDescriptor = {
      id: "sess_empty",
      kind: "agent-cli",
      workspaceSlug: "test",
      command: "mock",
      pid: null,
      status: "running",
      startedAt: new Date().toISOString(),
      turnsCompleted: 1,
      busy: false,
      lastTurnEmpty: true,
    }
    const { client } = await connectedClient(makeRegistry({ sess_empty: desc }))

    const result = await client.callTool({
      name: "session_monitor",
      arguments: { sessionIds: ["sess_empty"], event: "turn-end", since: 0 },
    })

    expect((result as { isError?: boolean }).isError).toBe(true)
    const payload = parseToolJson(result)
    expect(payload.empty).toBe(true)
    expect(payload.error).toContain("empty turn")
  })

  it("reason: \"error\" → isError: true with an actionable message", async () => {
    const desc: SessionDescriptor = {
      id: "sess_err",
      kind: "agent-cli",
      workspaceSlug: "test",
      command: "mock",
      pid: null,
      status: "running",
      startedAt: new Date().toISOString(),
      turnsCompleted: 1,
      busy: false,
      lastTurnReason: "error",
    }
    const { client } = await connectedClient(makeRegistry({ sess_err: desc }))

    const result = await client.callTool({
      name: "session_monitor",
      arguments: { sessionIds: ["sess_err"], event: "turn-end", since: 0 },
    })

    expect((result as { isError?: boolean }).isError).toBe(true)
    const payload = parseToolJson(result)
    expect(payload.reason).toBe("error")
    expect(payload.error).toContain("reason 'error'")
  })

  it("a productive turn does NOT set isError", async () => {
    const desc: SessionDescriptor = {
      id: "sess_ok",
      kind: "agent-cli",
      workspaceSlug: "test",
      command: "mock",
      pid: null,
      status: "running",
      startedAt: new Date().toISOString(),
      turnsCompleted: 1,
      busy: false,
    }
    const { client } = await connectedClient(makeRegistry({ sess_ok: desc }))

    const result = await client.callTool({
      name: "session_monitor",
      arguments: { sessionIds: ["sess_ok"], event: "turn-end", since: 0 },
    })

    expect((result as { isError?: boolean }).isError).toBeFalsy()
    const payload = parseToolJson(result)
    expect(payload.empty).toBeUndefined()
    expect(payload.reason).toBeUndefined()
  })
})

/**
 * End-to-end test (real MCP + REST transports) for the structured
 * awaiting-input protocol: a session's `awaitingQuestion` (structured or
 * heuristic, set in sessions.ts) must be readable from `session_monitor`,
 * `policy_status`, and `GET /sessions/:id/wait` without a separate call to
 * re-read raw transcript output. Also exercises all three
 * `monitorSessionWait` branches (ring-replay, sync-check, bus long-poll)
 * since REST and MCP both delegate to the same shared function.
 */

import { describe, it, expect, vi } from "vitest"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { createMcpServer } from "@agentproto/mcp-server"

import { registerOrchestrationTools } from "../orchestration-tools.js"
import { createCompletionPolicySupervisor } from "../supervisor.js"
import { createSessionEventBus } from "../session-event-bus.js"
import { createEventRing } from "../event-ring.js"
import { startHttpServer } from "../http-server.js"
import { createRuntimeEvents } from "../events.js"
import type { ConversationStore } from "../conversations.js"
import type { HeartbeatRunner } from "../heartbeat.js"
import type { SessionsRegistry, SessionDescriptor } from "../sessions.js"

const QUESTION = {
  text: "Which environment should I target?",
  options: ["staging", "production"],
  source: "heuristic" as const,
}

function makeMockRegistry(): SessionsRegistry {
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
    incWatchers: vi.fn(),
    decWatchers: vi.fn(),
    spawn: vi.fn(),
    register: vi.fn(),
    spawnAgent: vi.fn(),
    spawnPty: vi.fn(),
    sendPrompt: vi.fn(async () => {}),
    enqueuePrompt: vi.fn(),
    list: vi.fn(() => [desc]),
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

function parseToolJson(result: unknown): any {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content
  const text = content?.find(c => c.type === "text")?.text
  if (!text) throw new Error("tool returned no text content")
  return JSON.parse(text)
}

describe("structured awaiting-input — MCP transport e2e", () => {
  it("session_monitor's sync-check path surfaces the awaitingQuestion", async () => {
    const bus = createSessionEventBus()
    const eventRing = createEventRing()
    const registry = makeMockRegistry()

    const server = new McpServer({ name: "question-e2e-server", version: "0.0.0" })
    registerOrchestrationTools(server, { registry, sessionEvents: bus, eventRing })

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const client = new Client({ name: "question-e2e-client", version: "0.0.0" })
    await client.connect(clientTransport)

    const res = parseToolJson(
      await client.callTool({
        name: "session_monitor",
        arguments: { sessionIds: ["sess_awaiting"], event: "awaiting-input" },
      }),
    )

    expect(res.event).toBe("awaiting-input")
    expect(res.awaitingInput).toBe(true)
    expect(res.question).toEqual(QUESTION)
  })

  it("policy_status enriches the response with awaitingQuestions for blocked watched sessions", async () => {
    const bus = createSessionEventBus()
    const registry = makeMockRegistry()
    const workspace = await mkdtemp(join(tmpdir(), "agentproto-question-e2e-"))
    await mkdir(join(workspace, ".agentproto"), { recursive: true })
    await writeFile(
      join(workspace, ".agentproto", "allowed-commands.json"),
      JSON.stringify({ version: 1, commands: ["true"] }),
      "utf8",
    )

    try {
      const supervisor = createCompletionPolicySupervisor({ registry, sessionEvents: bus, workspace })
      const eventRing = createEventRing()

      const server = new McpServer({ name: "question-e2e-server-2", version: "0.0.0" })
      registerOrchestrationTools(server, { registry, sessionEvents: bus, eventRing, supervisor })

      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
      await server.connect(serverTransport)
      const client = new Client({ name: "question-e2e-client-2", version: "0.0.0" })
      await client.connect(clientTransport)

      // Attach a policy watching the (perpetually) awaiting-input session —
      // no gate ever runs since turn-end/awaiting-input is never emitted on
      // the bus, so the policy stays "watching" while the underlying
      // session sits blocked on a question.
      const attached = parseToolJson(
        await client.callTool({
          name: "policy_attach",
          arguments: { sessionId: "sess_awaiting", then: "emit" },
        }),
      )
      expect(attached.status).toBe("watching")

      const status = parseToolJson(
        await client.callTool({ name: "policy_status", arguments: { policyId: attached.policyId } }),
      )

      expect(status.status).toBe("watching")
      expect(status.awaitingQuestions).toEqual([{ sessionId: "sess_awaiting", question: QUESTION }])
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })
})

describe("structured awaiting-input — GET /sessions/:id/wait (REST transport) e2e", () => {
  // Map-backed stub registry — lets a test mutate a descriptor in place to
  // simulate a session transitioning into awaiting-input mid-wait (for the
  // bus long-poll branch), unlike the fixed single-session mock above.
  function makeRegistry(descs: Record<string, SessionDescriptor>): SessionsRegistry {
    return {
      get: vi.fn((id: string) => descs[id]),
      findByIdOrName: vi.fn((q: string) => descs[q]),
      // The wait long-poll registers/releases a watcher on the blocking branch
      // (#session-visibility) — the real registry counts these; the stub only
      // needs to not throw.
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

  function makeDesc(id: string, overrides: Partial<SessionDescriptor> = {}): SessionDescriptor {
    return {
      id,
      kind: "agent-cli",
      workspaceSlug: "test",
      command: "mock",
      pid: null,
      status: "running",
      startedAt: new Date().toISOString(),
      ...overrides,
    }
  }

  async function withServer(
    sessions: SessionsRegistry,
    sessionEvents: ReturnType<typeof createSessionEventBus>,
    eventRing: ReturnType<typeof createEventRing>,
    fn: (base: string) => Promise<void>,
  ): Promise<void> {
    const port = await freePort()
    const http = await startHttpServer({
      port,
      auth: { mode: "none" },
      mcpServerFactory: async () =>
        (await createMcpServer({ specs: [], name: "main", version: "0" })).server,
      conversations: noopConversations(),
      events: createRuntimeEvents(),
      heartbeat: noopHeartbeat(),
      sessions,
      sessionEvents,
      eventRing,
      meta: { workspace: process.cwd(), registered: [] },
    })
    try {
      await fn(`http://127.0.0.1:${port}`)
    } finally {
      await http.stop()
    }
  }

  it("sync-check branch (source: state) forwards `question` over REST", async () => {
    const sessionEvents = createSessionEventBus()
    const eventRing = createEventRing()
    const desc = makeDesc("sess_state", { awaitingInput: true, awaitingQuestion: QUESTION })
    const registry = makeRegistry({ sess_state: desc })

    await withServer(registry, sessionEvents, eventRing, async base => {
      const res = await fetch(`${base}/sessions/sess_state/wait?event=awaiting-input&timeoutMs=2000`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as Record<string, unknown>
      expect(body.source).toBe("state")
      expect(body.awaitingInput).toBe(true)
      expect(body.question).toEqual(QUESTION)
    })
  })

  it("ring-replay branch (source: ring) forwards `question` over REST", async () => {
    const sessionEvents = createSessionEventBus()
    const eventRing = createEventRing()
    eventRing.wire(sessionEvents)
    const registry = makeRegistry({})

    const ringQuestion = { text: "Proceed with deploy?", options: ["yes", "no"], source: "structured" as const }
    sessionEvents.emit({
      type: "session:awaiting-input",
      sessionId: "sess_ring",
      ts: new Date().toISOString(),
      question: ringQuestion,
    })

    await withServer(registry, sessionEvents, eventRing, async base => {
      const res = await fetch(
        `${base}/sessions/sess_ring/wait?event=awaiting-input&since=0&timeoutMs=2000`,
      )
      expect(res.status).toBe(200)
      const body = (await res.json()) as Record<string, unknown>
      expect(body.source).toBe("ring")
      expect(body.question).toEqual(ringQuestion)
    })
  })

  it("bus long-poll branch (source: bus) forwards `question` over REST", async () => {
    const sessionEvents = createSessionEventBus()
    const eventRing = createEventRing()
    const desc = makeDesc("sess_bus", { awaitingInput: false })
    const registry = makeRegistry({ sess_bus: desc })
    const busQuestion = { text: "Which branch?", options: ["main", "dev"], source: "heuristic" as const }

    await withServer(registry, sessionEvents, eventRing, async base => {
      const waitPromise = fetch(
        `${base}/sessions/sess_bus/wait?event=awaiting-input&timeoutMs=5000`,
      )
      // Give the fetch time to reach the long-poll subscription before the
      // triggering event fires, so this genuinely exercises the bus branch
      // rather than racing the sync-check above.
      await new Promise(resolve => setTimeout(resolve, 50))
      desc.awaitingInput = true
      desc.awaitingQuestion = busQuestion
      sessionEvents.emit({
        type: "session:awaiting-input",
        sessionId: "sess_bus",
        ts: new Date().toISOString(),
        question: busQuestion,
      })

      const res = await waitPromise
      expect(res.status).toBe(200)
      const body = (await res.json()) as Record<string, unknown>
      expect(body.source).toBe("bus")
      expect(body.question).toEqual(busQuestion)
    })
  })
})

// ── tiny stubs (mirrors orchestrator-gateway.test.ts's local helpers) ──

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as AddressInfo).port
      srv.close(() => resolve(port))
    })
  })
}

function noopConversations(): ConversationStore {
  return {
    async open() {},
    async appendTurn() {},
    async read() {
      return { meta: {} as never, turns: [] }
    },
    async list() {
      return []
    },
    pathFor: (id: string) => id,
  }
}

function noopHeartbeat(): HeartbeatRunner {
  return {
    start() {},
    stop() {},
    async fireNow() {},
  }
}

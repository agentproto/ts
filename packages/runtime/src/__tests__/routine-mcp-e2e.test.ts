/**
 * End-to-end test for the routine orchestration over a REAL MCP transport.
 *
 * Unlike routine-runner.test.ts (which drives the RoutineRunner directly),
 * this wires the actual MCP surface:
 *
 *   Client ──InMemoryTransport──▶ McpServer
 *     │                              │
 *     │  routine_start / status      │ registerOrchestrationTools
 *     ▼                              ▼
 *   tool call ───────────────▶ real RoutineRunner ──▶ real SessionEventBus
 *
 * Only the agent SUBPROCESS is stubbed: the mock registry emits a
 * `session:turn-end` synchronously inside sendPrompt (the fast-session path),
 * so a started routine deterministically reaches "done" without spawning a
 * real claude-code session. Everything between the MCP tool boundary and the
 * runner's state machine is the production code path.
 */

import { describe, it, expect } from "vitest"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"

import { registerOrchestrationTools } from "../orchestration-tools.js"
import { createRoutineRunner } from "../routine-runner.js"
import { createSessionEventBus } from "../session-event-bus.js"
import { createEventRing } from "../event-ring.js"
import type { SessionsRegistry, SessionDescriptor } from "../sessions.js"
import type { SessionEventBus } from "../session-event-bus.js"
import type { AgentAdapterResolver } from "../http-server.js"
import type { RoutineRegistrar } from "../routine-registrar.js"

// `routine_list` was repointed (PLAN.md PR B1 #2) to the AIP-41 registrar's
// `list()` — routine DEFINITIONS, not RoutineRunner runs. This fixture
// stands in for the registrar in tests that don't need real `.routines/*`
// scanning.
function makeMockRegistrar(definitions: unknown[] = []): RoutineRegistrar {
  return {
    reconcile: () => ({ registered: [], skipped: [], removed: [], errors: [] }),
    trigger: async () => ({ ok: true, summary: "mock" }),
    list: () => definitions as ReturnType<RoutineRegistrar["list"]>,
  }
}

// ── Mock registry: spawn returns a fixed id; sendPrompt fires turn-end ──
// synchronously (reproduces the production fast-session path). get() reports
// the session as running (no awaitingInput) so the step completes cleanly.
function makeMockRegistry(bus: SessionEventBus): SessionsRegistry {
  const SESSION_ID = "sess_e2e"
  const desc: SessionDescriptor = {
    id: SESSION_ID,
    kind: "agent-cli",
    workspaceSlug: "test",
    command: "mock",
    pid: null,
    status: "running",
    startedAt: new Date().toISOString(),
  }
  return {
    spawnAgent: () => desc,
    sendPrompt: async (sessionId: string) => {
      // Fire turn-end synchronously — the runner subscribes BEFORE calling
      // sendPrompt, so this resolves the step's waitTurnEnd().
      bus.emit({ type: "session:turn-end", sessionId, awaitingInput: false, ts: "t" })
    },
    get: (id: string) => (id === SESSION_ID ? desc : undefined),
  } as unknown as SessionsRegistry
}

function makeMockAdapter(): AgentAdapterResolver {
  return (async () => ({
    startSession: async () => ({
      sessionId: "adapter_e2e",
      send: async function* () {},
      cancel: async () => {},
      close: async () => {},
    }),
    commandPreview: "mock-adapter",
  })) as unknown as AgentAdapterResolver
}

/** Parse the single text content block of an MCP tool result as JSON. */
function parseToolJson(result: unknown): any {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content
  const text = content?.find(c => c.type === "text")?.text
  if (!text) throw new Error("tool returned no text content")
  return JSON.parse(text)
}

describe("routine orchestration — MCP transport e2e", () => {
  async function setup(routineRegistrar?: RoutineRegistrar) {
    const bus = createSessionEventBus()
    const eventRing = createEventRing()
    const registry = makeMockRegistry(bus)
    const routineRunner = createRoutineRunner({
      registry,
      sessionEvents: bus,
      resolveAgentAdapter: makeMockAdapter(),
      // no persist / persistPath → never touches ~/.agentproto
    })

    const server = new McpServer({ name: "routine-e2e-server", version: "0.0.0" })
    registerOrchestrationTools(server, {
      registry,
      sessionEvents: bus,
      eventRing,
      routineRunner,
      ...(routineRegistrar ? { routineRegistrar } : {}),
    })

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const client = new Client({ name: "routine-e2e-client", version: "0.0.0" })
    await client.connect(clientTransport)
    return { client, server }
  }

  it("registers routine_start + routine_status + routine_cancel on the server (routine_list needs a registrar, not just a runner)", async () => {
    const { client } = await setup()
    const { tools } = await client.listTools()
    const names = tools.map(t => t.name)
    expect(names).toContain("routine_start")
    expect(names).toContain("routine_status")
    expect(names).toContain("routine_cancel")
    // routine_list moved off RoutineRunner (PLAN.md PR B1 #2) — without a
    // routineRegistrar wired, it's not registered at all.
    expect(names).not.toContain("routine_list")
  })

  it("routine_start/status/cancel/escalation_resolve descriptions are stamped DEPRECATED", async () => {
    const { client } = await setup()
    const { tools } = await client.listTools()
    for (const name of ["routine_start", "routine_status", "routine_cancel", "routine_escalation_resolve"]) {
      const tool = tools.find(t => t.name === name)
      expect(tool, `expected ${name} to be registered`).toBeDefined()
      expect(tool?.description).toMatch(/^DEPRECATED — use `workflow_\*`/)
    }
  })

  it("routine_start → routine_status reaches done over MCP", async () => {
    const { client } = await setup()

    const started = parseToolJson(
      await client.callTool({
        name: "routine_start",
        arguments: {
          routineId: "e2e-daily-brief",
          steps: [
            { label: "step1", adapter: "mock", prompt: "summarise" },
            { label: "step2", adapter: "mock", prompt: "and again" },
          ],
        },
      }),
    )
    expect(started.runId).toMatch(/^run_/)
    expect(started.status).toBe("running")

    // Poll routine_status over the wire until terminal.
    let final: any
    for (let i = 0; i < 100; i++) {
      final = parseToolJson(
        await client.callTool({ name: "routine_status", arguments: { runId: started.runId } }),
      )
      if (["done", "failed", "cancelled"].includes(final.status)) break
      await new Promise(res => setTimeout(res, 10))
    }

    expect(final.status).toBe("done")
    expect(final.steps).toHaveLength(2)
    expect(final.steps.every((s: { status: string }) => s.status === "done")).toBe(true)
    expect(final.result.sessionIds.length).toBeGreaterThan(0)
  })

  it("routine_list (wired with a registrar) returns AIP-41 routine DEFINITIONS, not RoutineRunner runs", async () => {
    const definitions = [{ id: "daily-brief", enabled: true, schedule: { kind: "cron", cron: "0 9 * * *" } }]
    const { client } = await setup(makeMockRegistrar(definitions))

    // Start a RoutineRunner run — routine_list must NOT reflect it.
    const started = parseToolJson(
      await client.callTool({
        name: "routine_start",
        arguments: { routineId: "e2e-listed", steps: [{ label: "only", adapter: "mock", prompt: "go" }] },
      }),
    )

    const routines = parseToolJson(await client.callTool({ name: "routine_list", arguments: {} }))
    expect(routines).toEqual(definitions)
    expect(routines.some((r: { runId?: string }) => r.runId === started.runId)).toBe(false)
  })

  it("routine_status on an unknown runId returns a clean error over MCP", async () => {
    const { client } = await setup()
    const res = parseToolJson(
      await client.callTool({ name: "routine_status", arguments: { runId: "run_does_not_exist" } }),
    )
    expect(res.error).toBe("run not found")
  })
})

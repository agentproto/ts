/**
 * End-to-end test for the (deprecated) routine orchestration over a REAL
 * MCP transport.
 *
 * The imperative RoutineRunner engine is gone — `routine_start` now lowers
 * to a single-step-per-stage AIP-15 workflow, driven by `workflowRunner`
 * (`routine-workflow-shim.ts`):
 *
 *   Client ──InMemoryTransport──▶ McpServer
 *     │                              │
 *     │  routine_start / status      │ registerOrchestrationTools
 *     ▼                              ▼
 *   tool call ──▶ routine-workflow-shim ──▶ real WorkflowRunner ──▶ real SessionEventBus
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
import { createRoutineWorkflowShim } from "../routine-workflow-shim.js"
import { createWorkflowRunner } from "../workflow-runner.js"
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

// ── Escalating mock registry: the first sendPrompt() puts the session into
// awaitingInput (fires session:awaiting-input); a SECOND sendPrompt() (the
// auto-allow/escalate-resolve response) clears it and fires turn-end. Lets
// the escalate/auto-allow suspend tests drive a real awaiting-input cycle
// without spawning a real session. ──
function makeEscalatingRegistry(bus: SessionEventBus): SessionsRegistry {
  const SESSION_ID = "sess_escalate"
  let awaitingInput = false
  let calls = 0
  const desc = (): SessionDescriptor => ({
    id: SESSION_ID,
    kind: "agent-cli",
    workspaceSlug: "test",
    command: "mock",
    pid: null,
    status: "running",
    startedAt: new Date().toISOString(),
    awaitingInput,
  })
  return {
    spawnAgent: () => desc(),
    sendPrompt: async (sessionId: string) => {
      calls++
      if (calls === 1) {
        awaitingInput = true
        bus.emit({ type: "session:awaiting-input", sessionId, ts: "t" })
      } else {
        awaitingInput = false
        bus.emit({ type: "session:turn-end", sessionId, awaitingInput: false, ts: "t" })
      }
    },
    get: (id: string) => (id === SESSION_ID ? desc() : undefined),
  } as unknown as SessionsRegistry
}

describe("routine orchestration — MCP transport e2e", () => {
  async function setupWithRegistry(registry: SessionsRegistry, bus: SessionEventBus, routineRegistrar?: RoutineRegistrar) {
    const eventRing = createEventRing()
    const workflowRunner = createWorkflowRunner({
      registry,
      sessionEvents: bus,
      resolveAgentAdapter: makeMockAdapter(),
      // no persist / persistPath → never touches ~/.agentproto
    })
    const routineRunner = createRoutineWorkflowShim({ workflowRunner })

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

  function setup(routineRegistrar?: RoutineRegistrar) {
    const bus = createSessionEventBus()
    return setupWithRegistry(makeMockRegistry(bus), bus, routineRegistrar)
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
    // Backed by a workflowRunner run now (routine-workflow-shim.ts) — id
    // prefix reflects that, not the retired RoutineRunner's `run_`.
    expect(started.runId).toMatch(/^wfrun_/)
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

  it("policy=auto-allow: the session's awaiting-input is answered automatically and the run reaches done", async () => {
    const bus = createSessionEventBus()
    const { client } = await setupWithRegistry(makeEscalatingRegistry(bus), bus)

    const started = parseToolJson(
      await client.callTool({
        name: "routine_start",
        arguments: {
          routineId: "auto-allow-test",
          steps: [
            {
              label: "step1",
              adapter: "mock",
              prompt: "go",
              policy: { awaiting: "auto-allow", prompt: "continue please" },
            },
          ],
        },
      }),
    )

    let final: any
    for (let i = 0; i < 100; i++) {
      final = parseToolJson(
        await client.callTool({ name: "routine_status", arguments: { runId: started.runId } }),
      )
      if (["done", "failed", "cancelled"].includes(final.status)) break
      await new Promise(res => setTimeout(res, 10))
    }

    expect(final.status).toBe("done")
    expect(final.steps[0].status).toBe("done")
  })

  it("policy=escalate: the run suspends to awaiting-input, then routine_escalation_resolve resumes it to done", async () => {
    const bus = createSessionEventBus()
    const { client } = await setupWithRegistry(makeEscalatingRegistry(bus), bus)

    const started = parseToolJson(
      await client.callTool({
        name: "routine_start",
        arguments: {
          routineId: "escalate-test",
          steps: [
            {
              label: "step1",
              adapter: "mock",
              prompt: "go",
              policy: { awaiting: "escalate", timeoutMs: 5_000 },
            },
          ],
        },
      }),
    )

    // Poll until the run suspends (workflow StepSuspend/StepApproval mapping
    // — see sessions-registry-agent-host.ts's onEscalate).
    let suspended: any
    for (let i = 0; i < 100; i++) {
      suspended = parseToolJson(
        await client.callTool({ name: "routine_status", arguments: { runId: started.runId } }),
      )
      if (suspended.status === "awaiting-input") break
      await new Promise(res => setTimeout(res, 10))
    }
    expect(suspended.status).toBe("awaiting-input")

    const resolved = parseToolJson(
      await client.callTool({
        name: "routine_escalation_resolve",
        arguments: { runId: started.runId, stepIndex: 0, response: "approved" },
      }),
    )
    expect(resolved.ok).toBe(true)

    let final: any
    for (let i = 0; i < 100; i++) {
      final = parseToolJson(
        await client.callTool({ name: "routine_status", arguments: { runId: started.runId } }),
      )
      if (["done", "failed", "cancelled"].includes(final.status)) break
      await new Promise(res => setTimeout(res, 10))
    }
    expect(final.status).toBe("done")
    expect(final.steps[0].status).toBe("done")
  })

  it("routine_start rejects a non-empty waitFor with a clear error — dropped along with the RoutineRunner engine", async () => {
    const { client } = await setup()

    const result = await client.callTool({
      name: "routine_start",
      arguments: {
        routineId: "wait-for-test",
        steps: [{ label: "step1", adapter: "mock", waitFor: ["some-other-session"] }],
      },
    })

    expect((result as { isError?: boolean }).isError).toBe(true)
    const content = (result as { content?: Array<{ type: string; text?: string }> }).content
    const text = content?.find(c => c.type === "text")?.text ?? ""
    expect(text).toMatch(/waitFor/)
  })
})

/**
 * End-to-end test for workflow orchestration over a REAL MCP transport.
 * Mirrors routine-mcp-e2e.test.ts's structure for the sibling primitive.
 *
 *   Client ──InMemoryTransport──▶ McpServer
 *     │                              │
 *     │  workflow_start / status     │ registerOrchestrationTools
 *     ▼                              ▼
 *   tool call ───────────────▶ real WorkflowRunner ──▶ real SessionEventBus
 *
 * Only the agent SUBPROCESS is stubbed: the mock registry emits
 * `session:turn-end` synchronously inside sendPrompt, so a started workflow
 * deterministically reaches "done" without spawning a real claude-code
 * session.
 */

import { describe, it, expect } from "vitest"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"

import { registerOrchestrationTools } from "../orchestration-tools.js"
import { createWorkflowRunner } from "../workflow-runner.js"
import { createSessionEventBus } from "../session-event-bus.js"
import { createEventRing } from "../event-ring.js"
import type { SessionsRegistry, SessionDescriptor } from "../sessions.js"
import type { SessionEventBus } from "../session-event-bus.js"
import type { AgentAdapterResolver } from "../http-server.js"

// ── Mock registry: spawn returns fresh ids; sendPrompt fires turn-end ──
// synchronously (reproduces the production fast-session path).
function makeMockRegistry(bus: SessionEventBus): SessionsRegistry {
  const descs = new Map<string, SessionDescriptor>()
  let counter = 0
  return {
    spawnAgent: () => {
      const id = `sess_e2e_${counter++}`
      const desc: SessionDescriptor = {
        id,
        kind: "agent-cli",
        workspaceSlug: "test",
        command: "mock",
        pid: null,
        status: "running",
        startedAt: new Date().toISOString(),
      }
      descs.set(id, desc)
      return desc
    },
    sendPrompt: async (sessionId: string) => {
      bus.emit({ type: "session:turn-end", sessionId, awaitingInput: false, ts: "t" })
    },
    get: (id: string) => descs.get(id),
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

describe("workflow orchestration — MCP transport e2e", () => {
  async function setup() {
    const bus = createSessionEventBus()
    const eventRing = createEventRing()
    const registry = makeMockRegistry(bus)
    const workflowRunner = createWorkflowRunner({
      registry,
      sessionEvents: bus,
      resolveAgentAdapter: makeMockAdapter(),
      // no persist / persistPath → never touches ~/.agentproto
    })

    const server = new McpServer({ name: "workflow-e2e-server", version: "0.0.0" })
    registerOrchestrationTools(server, { registry, sessionEvents: bus, eventRing, workflowRunner })

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const client = new Client({ name: "workflow-e2e-client", version: "0.0.0" })
    await client.connect(clientTransport)
    return { client, server }
  }

  it("registers workflow_start + workflow_status + workflow_list + workflow_cancel on the server", async () => {
    const { client } = await setup()
    const { tools } = await client.listTools()
    const names = tools.map(t => t.name)
    expect(names).toContain("workflow_start")
    expect(names).toContain("workflow_status")
    expect(names).toContain("workflow_list")
    expect(names).toContain("workflow_cancel")
    expect(names).toContain("workflow_escalation_resolve")
    expect(names).toContain("run_request_input")
  })

  it("run_request_input with no callerSessionId bound on this connection is a clean tool error", async () => {
    const { client } = await setup()
    const res = await client.callTool({
      name: "run_request_input",
      arguments: { prompt: "what tone?" },
    })
    expect(res.isError).toBe(true)
    expect(parseToolJson(res).error).toBe("no_caller_session")
  })

  it("workflow_start → workflow_status reaches done with a 2-stage, multi-step workflow", async () => {
    const { client } = await setup()

    const started = parseToolJson(
      await client.callTool({
        name: "workflow_start",
        arguments: {
          workflowId: "e2e-review-then-fix",
          stages: [
            {
              label: "review",
              steps: [
                { label: "reviewer-a", adapter: "mock", prompt: "review from angle A" },
                { label: "reviewer-b", adapter: "mock", prompt: "review from angle B" },
              ],
            },
            {
              label: "fix",
              steps: [{ label: "fixer", adapter: "mock", prompt: "apply fixes" }],
            },
          ],
        },
      }),
    )
    expect(started.runId).toMatch(/^wfrun_/)
    expect(started.status).toBe("running")

    let final: any
    for (let i = 0; i < 100; i++) {
      final = parseToolJson(
        await client.callTool({ name: "workflow_status", arguments: { runId: started.runId } }),
      )
      if (["done", "failed", "cancelled"].includes(final.status)) break
      await new Promise(res => setTimeout(res, 10))
    }

    expect(final.status).toBe("done")
    expect(final.stages).toHaveLength(2)
    expect(final.stages[0].steps).toHaveLength(2)
    expect(final.stages[0].steps.every((s: { status: string }) => s.status === "done")).toBe(true)
    expect(final.stages[1].steps).toHaveLength(1)
    expect(final.result.sessionIds.length).toBe(3)
  })

  it("workflow_list reflects the started run over MCP", async () => {
    const { client } = await setup()
    const started = parseToolJson(
      await client.callTool({
        name: "workflow_start",
        arguments: {
          workflowId: "e2e-listed",
          stages: [{ steps: [{ label: "only", adapter: "mock", prompt: "go" }] }],
        },
      }),
    )
    const runs = parseToolJson(await client.callTool({ name: "workflow_list", arguments: {} }))
    expect(Array.isArray(runs)).toBe(true)
    expect(runs.some((r: { runId: string }) => r.runId === started.runId)).toBe(true)
  })

  it("workflow_list: default call stays a bare array; page-walk with limit=2 covers exactly the unpaginated list", async () => {
    const { client } = await setup()
    const started: string[] = []
    for (const workflowId of ["e2e-pg-1", "e2e-pg-2", "e2e-pg-3"]) {
      const res = parseToolJson(
        await client.callTool({
          name: "workflow_start",
          arguments: { workflowId, stages: [{ steps: [{ label: "only", adapter: "mock", prompt: "go" }] }] },
        }),
      )
      started.push(res.runId)
    }

    const unpaginated = parseToolJson(await client.callTool({ name: "workflow_list", arguments: {} }))
    expect(Array.isArray(unpaginated)).toBe(true)
    const runIds = (rows: Array<{ runId: string }>): string[] => rows.map(r => r.runId)
    expect(runIds(unpaginated).sort()).toEqual([...started].sort())

    // Page-walk: envelope { items, nextCursor?, total }; union == unpaginated.
    const union: Array<{ runId: string }> = []
    let cursor: string | undefined
    do {
      const page = parseToolJson(
        await client.callTool({
          name: "workflow_list",
          arguments: { limit: 2, ...(cursor ? { cursor } : {}) },
        }),
      )
      expect(page.total).toBe(3)
      union.push(...page.items)
      cursor = page.nextCursor
    } while (cursor)
    expect(runIds(union).sort()).toEqual([...started].sort())
  })

  it("workflow_status on an unknown runId returns a clean error over MCP", async () => {
    const { client } = await setup()
    const res = parseToolJson(
      await client.callTool({ name: "workflow_status", arguments: { runId: "wfrun_does_not_exist" } }),
    )
    expect(res.error).toBe("run not found")
  })

  it("workflow_cancel stops a run", async () => {
    const { client } = await setup()
    const started = parseToolJson(
      await client.callTool({
        name: "workflow_start",
        arguments: {
          workflowId: "e2e-cancel",
          stages: [{ steps: [{ label: "only", adapter: "mock", prompt: "go" }] }],
        },
      }),
    )
    const cancelled = parseToolJson(
      await client.callTool({ name: "workflow_cancel", arguments: { runId: started.runId } }),
    )
    expect(["cancelled", "done"]).toContain(cancelled.status)
  })

  it("AIP-58 §3(a): an agent-backed step calling the real run_request_input tool on itself suspends the run; workflow_escalation_resolve resumes it", async () => {
    const bus = createSessionEventBus()
    const eventRing = createEventRing()
    const SESSION_ID = "sess_e2e_signal"
    // Set once the session-scoped client (below) is connected — `sendPrompt`
    // uses it to simulate the spawned session calling `run_request_input`
    // on ITSELF, mid-turn, exactly the way the daemon's per-connection
    // `?callerSessionId=` MCP server lets a session call tools about itself.
    let sessionClient: Client | undefined

    const registry = {
      spawnAgent: () => {
        const desc: SessionDescriptor = {
          id: SESSION_ID,
          kind: "agent-cli",
          workspaceSlug: "test",
          command: "mock",
          pid: null,
          status: "running",
          startedAt: new Date().toISOString(),
        }
        return desc
      },
      sendPrompt: async (sessionId: string) => {
        if (sessionClient) {
          const client = sessionClient
          sessionClient = undefined // only the FIRST turn signals; the resume turn doesn't.
          const result = parseToolJson(
            await client.callTool({
              name: "run_request_input",
              arguments: {
                prompt: "what tone should the brief use — formal or casual?",
                schema: { type: "object" },
              },
            }),
          )
          expect(result.ok).toBe(true)
        }
        bus.emit({ type: "session:turn-end", sessionId, awaitingInput: false, ts: "t" })
      },
      get: (id: string) =>
        id === SESSION_ID
          ? { id, kind: "agent-cli" as const, workspaceSlug: "test", command: "mock", pid: null, status: "running" as const, startedAt: "t" }
          : undefined,
    } as unknown as SessionsRegistry

    const workflowRunner = createWorkflowRunner({ registry, sessionEvents: bus, resolveAgentAdapter: makeMockAdapter() })

    // Main connection — drives workflow_start / workflow_status / workflow_escalation_resolve.
    const server = new McpServer({ name: "workflow-e2e-server", version: "0.0.0" })
    registerOrchestrationTools(server, { registry, sessionEvents: bus, eventRing, workflowRunner })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const client = new Client({ name: "workflow-e2e-client", version: "0.0.0" })
    await client.connect(clientTransport)

    // Session-scoped connection — mirrors the daemon binding `callerSessionId`
    // to the spawned session's own `/mcp` connection.
    const sessionServer = new McpServer({ name: "workflow-e2e-session-server", version: "0.0.0" })
    registerOrchestrationTools(sessionServer, {
      registry,
      sessionEvents: bus,
      eventRing,
      workflowRunner,
      callerSessionId: SESSION_ID,
    })
    const [sessionClientTransport, sessionServerTransport] = InMemoryTransport.createLinkedPair()
    await sessionServer.connect(sessionServerTransport)
    sessionClient = new Client({ name: "workflow-e2e-session-client", version: "0.0.0" })
    await sessionClient.connect(sessionClientTransport)

    const started = parseToolJson(
      await client.callTool({
        name: "workflow_start",
        arguments: {
          workflowId: "e2e-signal",
          stages: [{ steps: [{ label: "draft", adapter: "mock", prompt: "write it" }] }],
        },
      }),
    )

    let parked: any
    for (let i = 0; i < 100; i++) {
      parked = parseToolJson(await client.callTool({ name: "workflow_status", arguments: { runId: started.runId } }))
      if (parked.status === "awaiting-input" || parked.status === "failed") break
      await new Promise(res => setTimeout(res, 10))
    }
    expect(parked.status).toBe("awaiting-input")
    expect(parked.awaitingSuspend).toMatchObject({
      stepId: "draft",
      reason: "input-required",
      prompt: "what tone should the brief use — formal or casual?",
    })
    expect(parked.stages[0].steps[0].suspend).toMatchObject({ reason: "input-required" })

    const resumed = parseToolJson(
      await client.callTool({
        name: "workflow_escalation_resolve",
        arguments: { runId: started.runId, payload: { tone: "formal" } },
      }),
    )
    expect(resumed.ok).toBe(true)

    let final: any
    for (let i = 0; i < 100; i++) {
      final = parseToolJson(await client.callTool({ name: "workflow_status", arguments: { runId: started.runId } }))
      if (["done", "failed", "cancelled"].includes(final.status)) break
      await new Promise(res => setTimeout(res, 10))
    }
    expect(final.status).toBe("done")
    expect(final.awaitingSuspend).toBeUndefined()
  })
})

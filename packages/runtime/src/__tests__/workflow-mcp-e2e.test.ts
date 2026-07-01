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
})

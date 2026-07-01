/**
 * End-to-end test (real MCP transport) for the structured awaiting-input
 * protocol: a session's `awaitingQuestion` (structured or heuristic, set in
 * sessions.ts) must be readable from `session_monitor` and `policy_status`
 * without a separate call to re-read raw transcript output.
 */

import { describe, it, expect, vi } from "vitest"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { registerOrchestrationTools } from "../orchestration-tools.js"
import { createCompletionPolicySupervisor } from "../supervisor.js"
import { createSessionEventBus } from "../session-event-bus.js"
import { createEventRing } from "../event-ring.js"
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

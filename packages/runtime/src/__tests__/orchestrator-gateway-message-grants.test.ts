/**
 * The SCOPED orchestrator gateway forwards explicit
 * `defaults.messaging.grants` the same way it forwards the messaging
 * switches, so a scoped child's `message_send` sees them too.
 */

import { describe, it, expect, vi } from "vitest"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import type { Grant } from "@agentproto/policy"

import {
  createOrchestratorMcpServerFactory,
  type OrchestratorScope,
} from "../orchestrator-gateway.js"
import { createSessionsRegistry, type SessionsRegistry } from "../sessions.js"
import { createSessionEventBus } from "../session-event-bus.js"
import { createEventRing } from "../event-ring.js"
import type { AgentSessionLike, AgentStreamEvent, SessionDescriptor } from "../sessions.js"

function idle(): AgentSessionLike {
  return {
    sessionId: "acp_test",
    // eslint-disable-next-line require-yield
    async *send(): AsyncIterable<AgentStreamEvent> {
      return
    },
    async cancel() {},
    async close() {},
  }
}

function spawnNode(registry: SessionsRegistry, workspaceSlug: string, label: string): SessionDescriptor {
  return registry.spawnAgent({
    workspaceSlug,
    cwd: "/tmp",
    agentSession: idle(),
    adapterSlug: "mock",
    label,
    depth: 0,
  })
}

async function callSend(input: { grants: Grant[] | undefined }): Promise<{ isError: boolean; text: string }> {
  const sessionEvents = createSessionEventBus()
  const eventRing = createEventRing()
  eventRing.wire(sessionEvents)
  const registry = createSessionsRegistry({ sessionEvents, persist: false })
  const sender = spawnNode(registry, "app-agentik-pygmalion", "brain")
  const recipient = spawnNode(registry, "agentik-studio", "pm")
  const factory = createOrchestratorMcpServerFactory({
    workspace: process.cwd(),
    registry,
    sessionEvents,
    eventRing,
    messagingAllowSameWorkspace: false,
    ...(input.grants !== undefined ? { messagingGrants: input.grants } : {}),
  })
  const scope: OrchestratorScope = {
    token: "tok",
    tools: new Set(["message_send"]),
    ownerSessionId: sender.id,
    depth: 0,
    maxDepth: 1,
    maxChildren: 1,
    role: "supervisor",
  }
  const server = await factory(scope)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "test", version: "0.0.1" })
  await client.connect(clientTransport)
  try {
    const result = await client.callTool({
      name: "message_send",
      arguments: { to: recipient.id, text: "hello" },
    })
    return {
      isError: (result as { isError?: boolean }).isError === true,
      text: (result as { content: Array<{ text: string }> }).content[0]!.text,
    }
  } finally {
    await client.close()
    registry.shutdown()
  }
}

describe("scoped orchestrator gateway - explicit message grants", () => {
  it("lets a scoped child's message_send use the configured grant", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const result = await callSend({
        grants: [{ principal: "*", effect: "allow", actions: [{ action: "session:message" }] }],
      })
      expect(result.isError).toBe(false)
      expect(JSON.parse(result.text)).toMatchObject({ ok: true, relation: "granted" })
    } finally {
      warn.mockRestore()
    }
  })

  it("keeps the refusal when the scoped gateway has no grants", async () => {
    const result = await callSend({ grants: undefined })
    expect(result.isError).toBe(true)
    expect(result.text).toContain("forbidden_recipient")
  })
})

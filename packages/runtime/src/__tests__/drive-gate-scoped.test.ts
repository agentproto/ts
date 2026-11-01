/**
 * The scoped orchestrator gateway forwards explicit
 * `defaults.messaging.grants` to its session tools, so a scoped child's
 * drive call sees the same `session:prompt` / `session:control` grants the
 * plain daemon mount does.
 */

import { describe, expect, it, vi } from "vitest"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import type { Grant } from "@agentproto/policy"

vi.mock("../session-continue-fresh.js", async importOriginal => {
  const mod = await importOriginal<typeof import("../session-continue-fresh.js")>()
  return {
    ...mod,
    continueAgentSessionFresh: vi.fn(async () => {
      throw new Error("drive-gate-scoped-probe")
    }),
  }
})

import {
  createOrchestratorMcpServerFactory,
  type OrchestratorScope,
} from "../orchestrator-gateway.js"
import { createSessionsRegistry, type AgentSessionLike, type SessionsRegistry } from "../sessions.js"
import { createSessionEventBus } from "../session-event-bus.js"
import { createEventRing } from "../event-ring.js"

function idle(): AgentSessionLike {
  return {
    sessionId: "acp_test",
    // eslint-disable-next-line require-yield
    async *send() {
      return
    },
    async cancel() {},
    async close() {},
  }
}

async function callContinueFresh(grants: Grant[] | undefined): Promise<{ isError: boolean; text: string }> {
  const sessionEvents = createSessionEventBus()
  const eventRing = createEventRing()
  eventRing.wire(sessionEvents)
  const registry: SessionsRegistry = createSessionsRegistry({ sessionEvents, persist: false })
  const caller = registry.spawnAgent({
    workspaceSlug: "agentik-studio",
    cwd: "/tmp",
    agentSession: idle(),
    adapterSlug: "mock",
    depth: 0,
  })
  const target = registry.spawnAgent({
    workspaceSlug: "agentik-studio",
    cwd: "/tmp",
    agentSession: idle(),
    adapterSlug: "mock",
    depth: 0,
  })
  const factory = createOrchestratorMcpServerFactory({
    workspace: process.cwd(),
    registry,
    sessionEvents,
    eventRing,
    resolveAgentAdapter: (() => undefined) as never,
    ...(grants !== undefined ? { messagingGrants: grants } : {}),
  })
  const scope: OrchestratorScope = {
    token: "tok",
    tools: new Set(["session_continue_fresh"]),
    ownerSessionId: caller.id,
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
    const result = (await client.callTool({
      name: "session_continue_fresh",
      arguments: { sessionId: target.id },
    })) as { isError?: boolean; content: Array<{ text: string }> }
    return { isError: result.isError === true, text: result.content[0]!.text }
  } finally {
    await client.close()
    registry.shutdown()
  }
}

describe("scoped orchestrator gateway - explicit drive grants", () => {
  it("a scoped child's session_continue_fresh uses the configured control grant", async () => {
    const granted = await callContinueFresh([
      { principal: "*", effect: "allow", actions: [{ action: "session:control" }] },
    ])
    expect(granted.text).not.toContain("may only be driven by its owner")
    expect(granted.text).toContain("drive-gate-scoped-probe")
  })

  it("keeps the refusal when the scoped gateway has no grants", async () => {
    const refused = await callContinueFresh(undefined)
    expect(refused.isError).toBe(true)
    expect(refused.text).toContain("may only be driven by its owner")
  })
})

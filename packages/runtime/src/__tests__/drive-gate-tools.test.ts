/**
 * End-to-end through the five real drive tool handlers: a stranger refused
 * by the owner gate is admitted by a matching explicit grant under
 * `defaults.messaging.grants`, and stays refused without one.
 */

import { describe, expect, it, vi } from "vitest"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import type { Grant } from "@agentproto/policy"

vi.mock("../session-continue-fresh.js", async importOriginal => {
  const mod = await importOriginal<typeof import("../session-continue-fresh.js")>()
  return {
    ...mod,
    continueAgentSessionFresh: vi.fn(async () => {
      throw new Error("drive-gate-probe-reached")
    }),
  }
})

import { registerAgentTools } from "../agent-tools.js"
import { registerSessionTools } from "../session-tools.js"
import type { AgentAdapterResolver } from "../http-server.js"
import { createSessionsRegistry, type AgentSessionLike } from "../sessions.js"

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

async function connect(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "drive-gate-tools", version: "0.0.0" })
  await client.connect(clientTransport)
  return client
}

type Result = { isError?: boolean; content?: Array<{ type: string; text?: string }> }

async function callAgentTool(
  opts: { registry: ReturnType<typeof createSessionsRegistry>; callerSessionId: string; grants?: Grant[] },
  name: string,
  args: Record<string, unknown>,
): Promise<Result> {
  const server = new McpServer({ name: `agent-${name}`, version: "0.0.0" })
  registerAgentTools(server, {
    registry: opts.registry,
    callerSessionId: opts.callerSessionId,
    ...(opts.grants !== undefined ? { messagingGrants: opts.grants } : {}),
  })
  const client = await connect(server)
  return (await client.callTool({ name, arguments: args })) as Result
}

async function callSessionTool(
  opts: {
    registry: ReturnType<typeof createSessionsRegistry>
    callerSessionId: string
    grants?: Grant[]
    resolveAgentAdapter?: AgentAdapterResolver
  },
  name: string,
  args: Record<string, unknown>,
): Promise<Result> {
  const server = new McpServer({ name: `session-${name}`, version: "0.0.0" })
  registerSessionTools(server, {
    registry: opts.registry,
    workspace: process.cwd(),
    callerSessionId: opts.callerSessionId,
    ...(opts.grants !== undefined ? { messagingGrants: opts.grants } : {}),
    ...(opts.resolveAgentAdapter ? { resolveAgentAdapter: opts.resolveAgentAdapter } : {}),
  })
  const client = await connect(server)
  return (await client.callTool({ name, arguments: args })) as Result
}

function forest() {
  const registry = createSessionsRegistry({ persist: false })
  const parent = registry.spawnAgent({
    workspaceSlug: "default",
    cwd: "/tmp",
    agentSession: instantAgentSession(),
    adapterSlug: "fake",
  })
  const child = registry.spawnAgent({
    workspaceSlug: "default",
    cwd: "/tmp",
    agentSession: instantAgentSession(),
    adapterSlug: "fake",
    parentSessionId: parent.id,
  })
  return { registry, parent, child }
}

const text = (r: Result): string => r.content?.[0]?.text ?? ""

function grant(action: "session:prompt" | "session:control", scope: string): Grant {
  return { principal: "*", effect: "allow", actions: [{ action, scope }] }
}

describe("drive tools through their real handlers", () => {
  it("agent_prompt: refused without a grant, admitted with session:prompt", async () => {
    const { registry, child } = forest()
    const refused = await callAgentTool(
      { registry, callerSessionId: "sess_stranger" },
      "agent_prompt",
      { sessionId: child.id, prompt: "go" },
    )
    expect(refused.isError).toBe(true)
    expect(text(refused)).toContain("agent_prompt: session")
    const admitted = await callAgentTool(
      { registry, callerSessionId: "sess_stranger", grants: [grant("session:prompt", child.id)] },
      "agent_prompt",
      { sessionId: child.id, prompt: "go" },
    )
    expect(admitted.isError).toBeUndefined()
    registry.shutdown()
  })

  it("agent_interrupt: refused without a grant, admitted with session:control", async () => {
    const { registry, child } = forest()
    const refused = await callAgentTool(
      { registry, callerSessionId: "sess_stranger" },
      "agent_interrupt",
      { sessionId: child.id },
    )
    expect(refused.isError).toBe(true)
    expect(text(refused)).toContain("agent_interrupt: session")
    const admitted = await callAgentTool(
      { registry, callerSessionId: "sess_stranger", grants: [grant("session:control", child.id)] },
      "agent_interrupt",
      { sessionId: child.id },
    )
    expect(admitted.isError).toBeUndefined()
    registry.shutdown()
  })

  it("agent_kill: refused without a grant, admitted with session:control", async () => {
    const { registry, child } = forest()
    const refused = await callAgentTool(
      { registry, callerSessionId: "sess_stranger" },
      "agent_kill",
      { sessionId: child.id },
    )
    expect(refused.isError).toBe(true)
    expect(text(refused)).toContain("agent_kill: session")
    const admitted = await callAgentTool(
      { registry, callerSessionId: "sess_stranger", grants: [grant("session:control", child.id)] },
      "agent_kill",
      { sessionId: child.id },
    )
    expect(admitted.isError).toBeUndefined()
    registry.shutdown()
  })

  it("session_restart: refused without a grant, past the gate with session:control", async () => {
    const { registry, child } = forest()
    const refused = await callSessionTool(
      { registry, callerSessionId: "sess_stranger" },
      "session_restart",
      { sessionId: child.id, model: "m" },
    )
    expect(refused.isError).toBe(true)
    expect(text(refused)).toContain("session_restart: session")
    const admitted = await callSessionTool(
      { registry, callerSessionId: "sess_stranger", grants: [grant("session:control", child.id)] },
      "session_restart",
      { sessionId: child.id, model: "m" },
    )
    expect(text(admitted)).not.toContain("may only be driven by its owner")
    expect(text(admitted)).toContain("restart-with-override")
    registry.shutdown()
  })

  it("session_continue_fresh: refused without a grant, past the gate with session:control", async () => {
    const { registry, child } = forest()
    const resolveAgentAdapter = (async () => {
      throw new Error("unused")
    }) as unknown as AgentAdapterResolver
    const refused = await callSessionTool(
      { registry, callerSessionId: "sess_stranger", resolveAgentAdapter },
      "session_continue_fresh",
      { sessionId: child.id },
    )
    expect(refused.isError).toBe(true)
    expect(text(refused)).toContain("session_continue_fresh: session")
    const admitted = await callSessionTool(
      {
        registry,
        callerSessionId: "sess_stranger",
        resolveAgentAdapter,
        grants: [grant("session:control", child.id)],
      },
      "session_continue_fresh",
      { sessionId: child.id },
    )
    expect(text(admitted)).not.toContain("may only be driven by its owner")
    expect(text(admitted)).toContain("drive-gate-probe-reached")
    registry.shutdown()
  })
})

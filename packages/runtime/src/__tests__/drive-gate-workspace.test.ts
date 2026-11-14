/**
 * A `workspace:<slug>` scope on a `session:prompt` / `session:control` grant
 * resolves the TARGET's verified workspace from its cwd, through the same
 * `createWorkspaceOfCwd()` lookup the messaging paths use. The five drive
 * tools do not inject a lookup, so the default has to be wired: the
 * workspaces config is replaced here, and the real handlers decide.
 */

import { describe, expect, it, vi } from "vitest"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import type { Grant } from "@agentproto/policy"

vi.mock("../workspace-binding.js", async importOriginal => {
  const mod = await importOriginal<typeof import("../workspace-binding.js")>()
  return {
    ...mod,
    createWorkspaceOfCwd: () => (cwd: string) => (cwd === "/ws/studio" ? "agentik-studio" : undefined),
  }
})

import { checkDrive } from "../drive-gate.js"
import { registerAgentTools } from "../agent-tools.js"
import { createSessionsRegistry, type AgentSessionLike, type SessionDescriptor } from "../sessions.js"

function idleAgentSession(): AgentSessionLike {
  return {
    sessionId: "idle-session",
    async *send() {
      yield { kind: "turn-end", reason: "completed" }
    },
    async cancel() {},
    async close() {},
  }
}

const grant = (scope: string): Grant => ({
  principal: "*",
  effect: "allow",
  actions: [{ action: "session:control", scope }],
})

function target(registry: ReturnType<typeof createSessionsRegistry>, cwd: string): SessionDescriptor {
  return registry.spawnAgent({
    workspaceSlug: "default",
    cwd,
    agentSession: idleAgentSession(),
    adapterSlug: "fake",
  })
}

async function kill(
  registry: ReturnType<typeof createSessionsRegistry>,
  sessionId: string,
  grants: Grant[],
): Promise<{ isError?: boolean; content?: Array<{ text?: string }> }> {
  const server = new McpServer({ name: "drive-gate-workspace", version: "0.0.0" })
  registerAgentTools(server, {
    registry,
    callerSessionId: "sess_stranger",
    messagingGrants: grants,
  })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "drive-gate-workspace", version: "0.0.0" })
  await client.connect(clientTransport)
  return (await client.callTool({ name: "agent_kill", arguments: { sessionId } })) as {
    isError?: boolean
    content?: Array<{ text?: string }>
  }
}

describe("workspace: scope on a drive grant", () => {
  it("agent_kill: the target's verified workspace admits, another slug does not", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const inStudio = target(registry, "/ws/studio")
    const refused = await kill(registry, inStudio.id, [grant("workspace:other")])
    expect(refused.isError).toBe(true)
    expect(refused.content?.[0]?.text).toContain("agent_kill: session")
    const admitted = await kill(registry, inStudio.id, [grant("workspace:agentik-studio")])
    expect(admitted.isError).toBeUndefined()
    registry.shutdown()
  })

  it("agent_kill: an unregistered cwd matches no workspace scope", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const stray = target(registry, "/somewhere/else")
    const refused = await kill(registry, stray.id, [grant("workspace:agentik-studio")])
    expect(refused.isError).toBe(true)
    registry.shutdown()
  })

  it("checkDrive honors an injected lookup over the default", () => {
    const registry = createSessionsRegistry({ persist: false })
    const stray = target(registry, "/somewhere/else")
    const call = (workspaceOfCwd?: (cwd: string) => string | undefined) =>
      checkDrive({
        registry,
        grants: [grant("workspace:injected")],
        callerSessionId: "sess_stranger",
        target: stray,
        tool: "agent_kill",
        ...(workspaceOfCwd ? { workspaceOfCwd } : {}),
      })
    expect(call().ok).toBe(false)
    expect(call(() => "injected")).toEqual({ ok: true })
    expect(call(() => "elsewhere").ok).toBe(false)
    registry.shutdown()
  })
})

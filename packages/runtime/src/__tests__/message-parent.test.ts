/**
 * Unit coverage for the `message_parent` MCP tool (agent-tools.ts) — the
 * child→parent half of the supervision channel. Unlike `agent_prompt` (a
 * delegation tool: drive ANY session by id), this tool takes no session id:
 * the daemon resolves the caller's own recorded `parentSessionId` and can
 * reach nothing else. Delivery mirrors supervisor-notify.ts: enqueue on an
 * idle parent, stamp onto the pending-notice queue on a busy one — never
 * interrupt an in-flight turn.
 *
 * Caller identity comes from either attribution channel, same precedence
 * as spawn attribution: the scoped orchestrator gateway's verified scope
 * (`callerScope.ownerSessionId`), else the plain `/mcp` path's trusted
 * `?callerSessionId=` query (`callerSessionId`).
 */

import { describe, it, expect, vi } from "vitest"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { createMcpServer } from "@agentproto/mcp-server"

import { registerAgentTools } from "../agent-tools.js"
import { createSessionsRegistry, type SessionsRegistry } from "../sessions.js"
import type { AgentSessionLike, AgentStreamEvent, SessionDescriptor } from "../sessions.js"
import type { OrchestratorScope } from "../orchestrator-gateway.js"

function fakeAgentSession(): AgentSessionLike {
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

function spawnNode(
  registry: SessionsRegistry,
  parentSessionId?: string,
  label?: string,
): SessionDescriptor {
  return registry.spawnAgent({
    workspaceSlug: "w",
    cwd: "/tmp",
    agentSession: fakeAgentSession(),
    adapterSlug: "mock",
    ...(parentSessionId ? { parentSessionId } : {}),
    ...(label ? { label } : {}),
    depth: parentSessionId ? 1 : 0,
  })
}

async function harness(opts: {
  registry: SessionsRegistry
  callerSessionId?: string
  callerScope?: OrchestratorScope
}) {
  const { server } = await createMcpServer({ specs: [], name: "main", version: "0" })
  registerAgentTools(server, {
    registry: opts.registry,
    ...(opts.callerSessionId ? { callerSessionId: opts.callerSessionId } : {}),
    ...(opts.callerScope ? { callerScope: opts.callerScope } : {}),
  })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "test", version: "0.0.1" })
  await client.connect(clientTransport)
  return { client, close: async () => client.close() }
}

function textOf(result: unknown): string {
  return (result as { content: Array<{ text: string }> }).content[0]!.text
}

function isError(result: unknown): boolean {
  return (result as { isError?: boolean }).isError === true
}

describe("message_parent — delivery", () => {
  it("idle parent: enqueues a `[child-message]` prompt on the recorded parent (root-gateway attribution)", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const parent = spawnNode(registry)
    const child = spawnNode(registry, parent.id, "worker-a")
    const enqueue = vi.spyOn(registry, "enqueuePrompt").mockResolvedValue(undefined)
    const h = await harness({ registry, callerSessionId: child.id })
    try {
      const result = await h.client.callTool({
        name: "message_parent",
        arguments: { message: "done: 3 files patched" },
      })
      expect(isError(result)).toBeFalsy()
      expect(JSON.parse(textOf(result))).toEqual({
        ok: true,
        parentSessionId: parent.id,
        delivery: "enqueued",
      })
      expect(enqueue).toHaveBeenCalledTimes(1)
      expect(enqueue).toHaveBeenCalledWith(
        parent.id,
        `[child-message] worker-a (${child.id}): done: 3 files patched`,
        { origin: "child:worker-a" },
      )
    } finally {
      await h.close()
    }
  })

  it("busy parent: stamps the pending-notice queue instead — a report never interrupts an in-flight turn", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const parent = spawnNode(registry)
    const child = spawnNode(registry, parent.id)
    registry.get(parent.id)!.busy = true
    const enqueue = vi.spyOn(registry, "enqueuePrompt").mockResolvedValue(undefined)
    const stamp = vi.spyOn(registry, "stampPendingChildCrashNotice")
    const h = await harness({ registry, callerSessionId: child.id })
    try {
      const result = await h.client.callTool({
        name: "message_parent",
        arguments: { message: "blocked on missing env var" },
      })
      expect(isError(result)).toBeFalsy()
      expect(JSON.parse(textOf(result))).toEqual({
        ok: true,
        parentSessionId: parent.id,
        delivery: "queued-next-turn",
      })
      expect(enqueue).not.toHaveBeenCalled()
      expect(stamp).toHaveBeenCalledWith(
        parent.id,
        `[child-message] ${child.id} (${child.id}): blocked on missing env var`,
      )
    } finally {
      await h.close()
    }
  })

  it("scoped-gateway attribution: `callerScope.ownerSessionId` identifies the caller (and wins over callerSessionId)", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const parent = spawnNode(registry)
    const child = spawnNode(registry, parent.id)
    const enqueue = vi.spyOn(registry, "enqueuePrompt").mockResolvedValue(undefined)
    const callerScope: OrchestratorScope = {
      token: "tok",
      tools: new Set(["message_parent"]),
      ownerSessionId: child.id,
      depth: 1,
      maxDepth: 3,
      maxChildren: 8,
      role: "executor",
    }
    const h = await harness({ registry, callerScope, callerSessionId: "someone-else" })
    try {
      const result = await h.client.callTool({
        name: "message_parent",
        arguments: { message: "hello" },
      })
      expect(isError(result)).toBeFalsy()
      expect(enqueue).toHaveBeenCalledWith(
        parent.id,
        expect.stringContaining(`(${child.id}): hello`),
        { origin: `child:${child.id}` },
      )
    } finally {
      await h.close()
    }
  })
})

describe("message_parent — refusals", () => {
  it("no attribution at all (human/root caller) → clear error, nothing delivered", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const enqueue = vi.spyOn(registry, "enqueuePrompt")
    const h = await harness({ registry })
    try {
      const result = await h.client.callTool({
        name: "message_parent",
        arguments: { message: "hi" },
      })
      expect(isError(result)).toBe(true)
      expect(textOf(result)).toContain("cannot identify the calling session")
      expect(enqueue).not.toHaveBeenCalled()
    } finally {
      await h.close()
    }
  })

  it("caller has no recorded parent (root spawn) → clear error", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const rootling = spawnNode(registry)
    const h = await harness({ registry, callerSessionId: rootling.id })
    try {
      const result = await h.client.callTool({
        name: "message_parent",
        arguments: { message: "hi" },
      })
      expect(isError(result)).toBe(true)
      expect(textOf(result)).toContain("no recorded parent")
    } finally {
      await h.close()
    }
  })

  it("parent no longer in the registry → clear error", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const child = spawnNode(registry, "sess_gone1234")
    const h = await harness({ registry, callerSessionId: child.id })
    try {
      const result = await h.client.callTool({
        name: "message_parent",
        arguments: { message: "hi" },
      })
      expect(isError(result)).toBe(true)
      expect(textOf(result)).toContain("no longer exists")
    } finally {
      await h.close()
    }
  })

  it("parent present but not running → clear error naming the status", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const parent = spawnNode(registry)
    const child = spawnNode(registry, parent.id)
    registry.get(parent.id)!.status = "exited"
    const h = await harness({ registry, callerSessionId: child.id })
    try {
      const result = await h.client.callTool({
        name: "message_parent",
        arguments: { message: "hi" },
      })
      expect(isError(result)).toBe(true)
      expect(textOf(result)).toContain("not running")
      expect(textOf(result)).toContain("exited")
    } finally {
      await h.close()
    }
  })
})

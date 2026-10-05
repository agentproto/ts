/**
 * `session_reorder_pinned` MCP tool (session-tools.ts) — end-to-end through
 * the real MCP client surface. Covers the happy path (positions assigned in
 * the given order, descriptors returned in the new order), the unknown-id
 * and unpinned-id errors, and the WP4 subtree scoping rule: a scoped
 * orchestrator may only reorder when ALL the listed sessions are in its
 * subtree. Mirrors session-artifact-tools.test.ts's harness shape.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { createMcpServer } from "@agentproto/mcp-server"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { registerSessionTools } from "../session-tools.js"
import { createSessionsRegistry, type SessionsRegistry } from "../sessions.js"
import type { AgentSessionLike, AgentStreamEvent, SessionDescriptor } from "../sessions.js"
import { createSessionEventBus } from "../session-event-bus.js"
import {
  createScopeTokenRegistry,
  type OrchestratorScope,
  type ScopeTokenRegistry,
} from "../orchestrator-gateway.js"

let n = 0
function fakeAgentSession(): AgentSessionLike {
  return {
    sessionId: `c_${n++}`,
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
  depth = 0,
): SessionDescriptor {
  return registry.spawnAgent({
    workspaceSlug: "w",
    cwd: "/tmp",
    agentSession: fakeAgentSession(),
    adapterSlug: "mock",
    ...(parentSessionId ? { parentSessionId } : {}),
    depth,
  })
}

function firstJson<T>(result: { content: Array<{ type: string; text?: string }> }): T {
  const text = result.content.find(c => c.type === "text")?.text
  return JSON.parse(text ?? "null") as T
}

describe("session_reorder_pinned MCP tool", () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "session-reorder-pinned-mcp-"))
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  interface Harness {
    client: Client
    registry: SessionsRegistry
    close: () => Promise<void>
  }

  async function buildHarness(opts?: {
    caller?: (scopeTokens: ScopeTokenRegistry, registry: SessionsRegistry) => OrchestratorScope | undefined
  }): Promise<Harness> {
    const sessionEvents = createSessionEventBus()
    const registry = createSessionsRegistry({ sessionEvents, persist: false })
    const scopeTokens = createScopeTokenRegistry()
    const callerScope = opts?.caller?.(scopeTokens, registry)

    const { server } = await createMcpServer({ specs: [], name: "test", version: "0" })
    registerSessionTools(server, {
      workspace: process.cwd(),
      registry,
      ...(callerScope ? { callerScope } : {}),
    })

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const client = new Client({ name: "test-client", version: "0" })
    await client.connect(clientTransport)

    return {
      client,
      registry,
      close: async () => {
        await client.close()
        await server.close()
      },
    }
  }

  it("reorders the pinned group and returns the descriptors in the new order", async () => {
    const h = await buildHarness()
    try {
      const a = spawnNode(h.registry)
      const b = spawnNode(h.registry)
      const c = spawnNode(h.registry)
      h.registry.setPinned(a.id, true)
      h.registry.setPinned(b.id, true)
      h.registry.setPinned(c.id, true)

      const result = await h.client.callTool({
        name: "session_reorder_pinned",
        arguments: { ids: [c.id, a.id] },
      })
      expect((result as { isError?: boolean }).isError).toBeFalsy()
      const descs = firstJson<Array<{ id: string; pinnedOrder: number }>>(result as never)
      expect(descs.map(d => d.id)).toEqual([c.id, a.id, b.id])
      expect(descs[0]!.pinnedOrder).toBe(0)
      expect(descs[1]!.pinnedOrder).toBe(1)
      expect(descs[2]!.pinnedOrder).toBe(2)
      expect(h.registry.get(b.id)?.pinnedOrder).toBe(2)
    } finally {
      await h.close()
    }
  })

  it("errors on an unknown session id", async () => {
    const h = await buildHarness()
    try {
      const result = await h.client.callTool({
        name: "session_reorder_pinned",
        arguments: { ids: ["sess_nope"] },
      })
      expect((result as { isError?: boolean }).isError).toBe(true)
      expect(JSON.stringify(result)).toContain("sess_nope")
    } finally {
      await h.close()
    }
  })

  it("errors on an unpinned session id", async () => {
    const h = await buildHarness()
    try {
      const a = spawnNode(h.registry)
      const result = await h.client.callTool({
        name: "session_reorder_pinned",
        arguments: { ids: [a.id] },
      })
      expect((result as { isError?: boolean }).isError).toBe(true)
      expect(JSON.stringify(result)).toContain("is not pinned")
    } finally {
      await h.close()
    }
  })

  it("a scoped orchestrator may only reorder sessions in its subtree", async () => {
    const h = await buildHarness({
      caller: (st, registry) => {
        const owner = spawnNode(registry)
        const scope = st.mint({ depth: 1 })
        st.bindOwner(scope.token, owner.id)
        return scope
      },
    })
    try {
      const owner = h.registry
        .list({ includeArchived: true })
        .find(s => s.depth === 0)!
      const child = spawnNode(h.registry, owner.id, 1)
      const outsider = spawnNode(h.registry)
      h.registry.setPinned(owner.id, true)
      h.registry.setPinned(child.id, true)
      h.registry.setPinned(outsider.id, true)

      const inScope = await h.client.callTool({
        name: "session_reorder_pinned",
        arguments: { ids: [child.id, owner.id] },
      })
      expect((inScope as { isError?: boolean }).isError).toBeFalsy()
      expect(h.registry.get(child.id)?.pinnedOrder).toBe(0)
      expect(h.registry.get(owner.id)?.pinnedOrder).toBe(1)

      const outOfScope = await h.client.callTool({
        name: "session_reorder_pinned",
        arguments: { ids: [child.id, outsider.id] },
      })
      expect((outOfScope as { isError?: boolean }).isError).toBe(true)
      expect(JSON.stringify(outOfScope)).toContain("orchestrator_session_out_of_scope")
    } finally {
      await h.close()
    }
  })
})

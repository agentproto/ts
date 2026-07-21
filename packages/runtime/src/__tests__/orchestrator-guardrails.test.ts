/**
 * Orchestrator recursion guardrails + subtree scoping (WP4).
 *
 * Drives the REAL `agent_start` / `session_list` /
 * `agent_kill` MCP tools with a `callerScope` set — exactly the
 * shape `createOrchestratorMcpServerFactory` builds per scoped request —
 * so the guards are exercised through the production handlers, not a
 * re-implementation. Proves:
 *   (a) a spawn via the scoped gateway attributes the child to the
 *       caller (`parentSessionId`) at `depth = caller.depth + 1`;
 *   (b) a spawn that would exceed `maxDepth` is rejected — no session;
 *   (c) a spawn past the per-parent child quota is rejected — no session;
 *   (d) a recursive child's requested subset is bounded by the PARENT's
 *       tools (non-re-grant), not just the global default;
 *   (e) `session_list`/`agent_kill` via a scoped token only
 *       see/affect the caller's subtree (descendants), nothing else;
 *   (f) the SAME tools, called WITHOUT a scope (root /mcp), see all
 *       sessions and may kill any of them.
 */

import { describe, it, expect } from "vitest"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { createMcpServer } from "@agentproto/mcp-server"
import type { AcpMcpServer } from "@agentproto/acp"

import { registerSessionTools } from "../session-tools.js"
import {
  createScopeTokenRegistry,
  createOrchestratorInjector,
  DEFAULT_ORCHESTRATOR_TOOLS,
  type ScopeTokenRegistry,
  type OrchestratorScope,
} from "../orchestrator-gateway.js"
import { createSessionsRegistry, type SessionsRegistry } from "../sessions.js"
import { createSessionEventBus } from "../session-event-bus.js"
import type {
  AgentSessionLike,
  AgentStreamEvent,
  SessionDescriptor,
} from "../sessions.js"
import type { AgentAdapterResolver } from "../http-server.js"

const PORT = 18790

let acpCounter = 0
/** A fake ACP session — never receives turns in these tests. */
function fakeAgentSession(): AgentSessionLike {
  return {
    sessionId: `acp_${acpCounter++}`,
    // eslint-disable-next-line require-yield
    async *send(): AsyncIterable<AgentStreamEvent> {
      return
    },
    async cancel() {},
    async close() {},
  }
}

interface SpawnCapture {
  mcpServers?: AcpMcpServer[]
  count: number
}

function makeResolver(capture: SpawnCapture): AgentAdapterResolver {
  return async () => ({
    async startSession(o: { mcpServers?: AcpMcpServer[] }) {
      capture.mcpServers = o.mcpServers
      capture.count += 1
      return fakeAgentSession()
    },
    commandPreview: "mock-adapter (agent)",
  })
}

interface Harness {
  client: Client
  registry: SessionsRegistry
  scopeTokens: ScopeTokenRegistry
  capture: SpawnCapture
  close: () => Promise<void>
}

/**
 * Build a server with `registerSessionTools`. The optional `caller`
 * callback runs after the registry + scope-token registry exist, so a
 * test can pre-spawn a session tree and mint/bind the calling scope
 * against real ids, then return the scope to install as `callerScope`
 * (or `undefined` for the root /mcp case).
 */
async function harness(opts?: {
  caller?: (
    scopeTokens: ScopeTokenRegistry,
    registry: SessionsRegistry,
  ) => OrchestratorScope | undefined
}): Promise<Harness> {
  const sessionEvents = createSessionEventBus()
  const registry = createSessionsRegistry({ sessionEvents, persist: false })
  const scopeTokens = createScopeTokenRegistry()
  const injector = createOrchestratorInjector({
    scopeTokens,
    sessionEvents,
    port: PORT,
  })
  const callerScope = opts?.caller?.(scopeTokens, registry)
  const capture: SpawnCapture = { count: 0 }

  const { server } = await createMcpServer({
    specs: [],
    name: "main",
    version: "0",
  })
  registerSessionTools(server, {
    registry,
    resolveAgentAdapter: makeResolver(capture),
    buildOrchestratorMcp: injector,
    ...(callerScope ? { callerScope } : {}),
  })

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "test", version: "0.0.1" })
  await client.connect(clientTransport)

  return {
    client,
    registry,
    scopeTokens,
    capture,
    close: async () => {
      await client.close()
    },
  }
}

/** Parse the JSON payload of a tool result's first text block. */
function payload<T = Record<string, unknown>>(result: unknown): T {
  const content = (result as { content: Array<{ text: string }> }).content
  return JSON.parse(content[0]!.text) as T
}

/** Spawn a tracked agent session straight through the registry, with
 *  an explicit parent + depth (simulating a prior subtree). */
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

/** Pull the injected scoped `agentproto` entry's `?scope=` token. */
function scopedToken(mcpServers?: AcpMcpServer[]): string {
  const entry = (mcpServers ?? []).find(s => s.name === "agentproto")
  expect(entry, "scoped agentproto entry present").toBeDefined()
  const token = new URL(entry!.ref ?? "").searchParams.get("scope")
  expect(token, "scope token in URL").toBeTruthy()
  return token!
}

const startArgs = { adapter: "mock", cwd: "/tmp" }

describe("orchestrator guardrails — parent attribution (WP4)", () => {
  it("(a) a spawn via the scoped gateway tags parentSessionId + depth = parent+1", async () => {
    const h = await harness({
      caller: st => {
        const scope = st.mint({ depth: 1 })
        st.bindOwner(scope.token, "parent-1")
        return scope
      },
    })
    try {
      const res = await h.client.callTool({
        name: "agent_start",
        arguments: startArgs,
      })
      const { id } = payload<{ id: string }>(res)
      const child = h.registry.get(id)
      expect(child, "child session exists").toBeDefined()
      expect(child!.parentSessionId).toBe("parent-1")
      expect(child!.depth).toBe(2) // caller.depth (1) + 1
      expect(h.capture.count).toBe(1)
    } finally {
      await h.close()
    }
  })

  it("a direct spawn (no scope) is a root: depth 0, no parent", async () => {
    const h = await harness() // no callerScope
    try {
      const res = await h.client.callTool({
        name: "agent_start",
        arguments: startArgs,
      })
      const { id } = payload<{ id: string }>(res)
      const child = h.registry.get(id)!
      expect(child.parentSessionId).toBeUndefined()
      expect(child.depth).toBe(0)
    } finally {
      await h.close()
    }
  })

  it("a scoped spawn IGNORES a caller-supplied parentSessionId hint (WP-R1) — the scope token wins", async () => {
    const h = await harness({
      caller: st => {
        const scope = st.mint({ depth: 1 })
        st.bindOwner(scope.token, "real-parent")
        return scope
      },
    })
    try {
      // A spoofed hint through the SCOPED gateway must be ignored: parent is
      // derived from the unspoofable token, not the caller's argument.
      const res = await h.client.callTool({
        name: "agent_start",
        arguments: { ...startArgs, parentSessionId: "attacker-chosen-parent" },
      })
      const { id } = payload<{ id: string }>(res)
      const child = h.registry.get(id)!
      expect(child.parentSessionId).toBe("real-parent")
      expect(child.depth).toBe(2) // caller.depth (1) + 1, NOT hint-derived
    } finally {
      await h.close()
    }
  })

  it("a root MCP spawn HONOURS the parentSessionId hint (WP-R1) and derives depth from the parent", async () => {
    const h = await harness() // no callerScope → anonymous root path
    try {
      const parent = spawnNode(h.registry, undefined, 2) // seed a depth-2 parent
      const res = await h.client.callTool({
        name: "agent_start",
        arguments: { ...startArgs, parentSessionId: parent.id },
      })
      const { id } = payload<{ id: string }>(res)
      const child = h.registry.get(id)!
      expect(child.parentSessionId).toBe(parent.id)
      expect(child.depth).toBe(3) // parent depth (2) + 1
    } finally {
      await h.close()
    }
  })
})

describe("orchestrator guardrails — recursion caps (WP4)", () => {
  it("(b) a spawn exceeding maxDepth is rejected and creates nothing", async () => {
    const h = await harness({
      caller: st => {
        // At the cap already: depth 3, maxDepth 3 → a child (depth 4) is over.
        const scope = st.mint({ depth: 3, maxDepth: 3 })
        st.bindOwner(scope.token, "deep-parent")
        return scope
      },
    })
    try {
      const res = await h.client.callTool({
        name: "agent_start",
        arguments: startArgs,
      })
      const body = payload<{ error: string; childDepth: number }>(res)
      expect(body.error).toBe("orchestrator_max_depth_exceeded")
      expect(body.childDepth).toBe(4)
      // No spawn happened: adapter.startSession never called, registry empty.
      expect(h.capture.count).toBe(0)
      expect(h.registry.list()).toHaveLength(0)
    } finally {
      await h.close()
    }
  })

  it("(c) a spawn past the per-parent child quota is rejected", async () => {
    const owner = "quota-parent"
    const h = await harness({
      caller: st => {
        const scope = st.mint({ depth: 0, maxChildren: 2 })
        st.bindOwner(scope.token, owner)
        return scope
      },
    })
    try {
      // Two children: both alive, both attributed to `owner`.
      await h.client.callTool({ name: "agent_start", arguments: startArgs })
      await h.client.callTool({ name: "agent_start", arguments: startArgs })
      expect(
        h.registry.list().filter(s => s.parentSessionId === owner),
      ).toHaveLength(2)

      // Third exceeds maxChildren=2 → rejected, no new session.
      const res = await h.client.callTool({
        name: "agent_start",
        arguments: startArgs,
      })
      const body = payload<{ error: string; aliveChildren: number }>(res)
      expect(body.error).toBe("orchestrator_child_quota_exceeded")
      expect(body.aliveChildren).toBe(2)
      expect(h.capture.count).toBe(2) // only the first two spawned
      expect(
        h.registry.list().filter(s => s.parentSessionId === owner),
      ).toHaveLength(2)
    } finally {
      await h.close()
    }
  })

  it("a freed (killed) child slot lets a new spawn through", async () => {
    const owner = "quota-parent-2"
    const h = await harness({
      caller: st => {
        const scope = st.mint({ depth: 0, maxChildren: 1 })
        st.bindOwner(scope.token, owner)
        return scope
      },
    })
    try {
      const first = payload<{ id: string }>(
        await h.client.callTool({ name: "agent_start", arguments: startArgs }),
      )
      // At the cap (1). Second is rejected.
      const blocked = payload<{ error?: string }>(
        await h.client.callTool({ name: "agent_start", arguments: startArgs }),
      )
      expect(blocked.error).toBe("orchestrator_child_quota_exceeded")
      // Free the slot, then a fresh spawn succeeds (no error field).
      h.registry.kill(first.id)
      const third = payload<{ error?: string; id?: string }>(
        await h.client.callTool({ name: "agent_start", arguments: startArgs }),
      )
      expect(third.error).toBeUndefined()
      expect(third.id).toBeDefined()
    } finally {
      await h.close()
    }
  })
})

describe("orchestrator guardrails — non-re-grant (WP4)", () => {
  it("(d) a recursive child cannot widen its subset beyond the parent's", async () => {
    const h = await harness({
      caller: st => {
        // Parent holds only a narrow subset (notably NOT kill/list).
        const scope = st.mint({
          tools: ["agent_start", "session_events_poll"],
          depth: 0,
        })
        st.bindOwner(scope.token, "narrow-parent")
        return scope
      },
    })
    try {
      // The child asks for the FULL default subset — strictly wider than
      // the parent's. It must be clamped to ⊆ the parent's tools.
      // `role: "supervisor"` opts back into `orchestrator` here — this
      // spawn is at depth 1, which now defaults to executor (role-
      // depth-cutoff) and would otherwise drop `orchestrator` entirely,
      // unrelated to the non-re-grant guarantee this test targets.
      await h.client.callTool({
        name: "agent_start",
        arguments: {
          ...startArgs,
          role: "supervisor",
          orchestrator: { tools: [...DEFAULT_ORCHESTRATOR_TOOLS] },
        },
      })
      const token = scopedToken(h.capture.mcpServers)
      const childScope = h.scopeTokens.verify(token)
      expect(childScope, "child token verifiable").not.toBeNull()
      expect([...childScope!.tools].sort()).toEqual([
        "agent_start",
        "session_events_poll",
      ])
      expect(childScope!.tools.has("agent_kill")).toBe(false)
      // Depth inherited as parent + 1.
      expect(childScope!.depth).toBe(1)
    } finally {
      await h.close()
    }
  })
})

describe("orchestrator guardrails — subtree scoping (WP4)", () => {
  // Tree shared by (e): C is the calling orchestrator; D,E are its
  // children; G is D's child (grandchild of C); X is unrelated.
  function buildTree(registry: SessionsRegistry): {
    C: string
    D: string
    E: string
    G: string
    X: string
  } {
    const C = spawnNode(registry, undefined, 0)
    const D = spawnNode(registry, C.id, 1)
    const E = spawnNode(registry, C.id, 1)
    const G = spawnNode(registry, D.id, 2)
    const X = spawnNode(registry, undefined, 0)
    return { C: C.id, D: D.id, E: E.id, G: G.id, X: X.id }
  }

  it("(e) session_list via a scoped token returns only the subtree; kill is subtree-bound", async () => {
    let ids!: ReturnType<typeof buildTree>
    const h = await harness({
      caller: (st, reg) => {
        ids = buildTree(reg)
        const scope = st.mint({ depth: 0 })
        st.bindOwner(scope.token, ids.C)
        return scope
      },
    })
    try {
      // list — only C's subtree {C,D,E,G}, never the unrelated X.
      const listed = payload<{ sessions: SessionDescriptor[] }>(
        await h.client.callTool({ name: "session_list", arguments: {} }),
      )
      const seen = new Set(listed.sessions.map(s => s.id))
      expect(seen).toEqual(new Set([ids.C, ids.D, ids.E, ids.G]))
      expect(seen.has(ids.X)).toBe(false)

      // kill OUT of subtree → refused, X stays alive.
      const refused = payload<{ error?: string; ok?: boolean }>(
        await h.client.callTool({
          name: "agent_kill",
          arguments: { sessionId: ids.X },
        }),
      )
      expect(refused.error).toBe("orchestrator_session_out_of_scope")
      expect(h.registry.get(ids.X)!.status).toBe("running")

      // kill IN subtree (the grandchild) → allowed.
      const allowed = payload<{ ok: boolean }>(
        await h.client.callTool({
          name: "agent_kill",
          arguments: { sessionId: ids.G },
        }),
      )
      expect(allowed.ok).toBe(true)
      expect(h.registry.get(ids.G)!.status).toBe("killed")
    } finally {
      await h.close()
    }
  })

  it("(f) WITHOUT a scope (root /mcp) the same tools see every session and may kill any", async () => {
    let ids!: ReturnType<typeof buildTree>
    const h = await harness({
      caller: (_st, reg) => {
        ids = buildTree(reg)
        return undefined // no callerScope → root operator
      },
    })
    try {
      const listed = payload<{ sessions: SessionDescriptor[] }>(
        await h.client.callTool({ name: "session_list", arguments: {} }),
      )
      const seen = new Set(listed.sessions.map(s => s.id))
      // Everything is visible, including the unrelated X.
      expect(seen).toEqual(
        new Set([ids.C, ids.D, ids.E, ids.G, ids.X]),
      )

      // The root may kill the unrelated X (no subtree restriction).
      const killed = payload<{ ok: boolean }>(
        await h.client.callTool({
          name: "agent_kill",
          arguments: { sessionId: ids.X },
        }),
      )
      expect(killed.ok).toBe(true)
      expect(h.registry.get(ids.X)!.status).toBe("killed")
    } finally {
      await h.close()
    }
  })
})

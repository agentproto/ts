/**
 * WP5 — session_tree observability tool.
 *
 * Three test groups:
 *   (a) buildSessionTree helper — correct parent→child nesting on 2-3 levels,
 *       isOrchestrator flag, depth ordering.
 *   (b) session_tree MCP tool with callerScope → only the caller's subtree.
 *   (c) session_tree MCP tool without scope → full daemon tree.
 *
 * Uses the same harness pattern as orchestrator-guardrails.test.ts.
 */

import { describe, it, expect } from "vitest"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { createMcpServer } from "@agentproto/mcp-server"

import {
  buildSessionTree,
  groupRootsByOrigin,
  registerSessionTools,
  UNKNOWN_ORIGIN,
  type SessionTreeNode,
} from "../session-tools.js"
import {
  createScopeTokenRegistry,
  createOrchestratorInjector,
  type ScopeTokenRegistry,
  type OrchestratorScope,
} from "../orchestrator-gateway.js"
import {
  createSessionsRegistry,
  type SessionsRegistry,
  type AgentSessionLike,
  type AgentStreamEvent,
  type SessionDescriptor,
} from "../sessions.js"
import { createSessionEventBus } from "../session-event-bus.js"

// ── helpers ───────────────────────────────────────────────────────────────────

let acpCounter = 0
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

function spawnNode(
  registry: SessionsRegistry,
  parentSessionId?: string,
  depth = 0,
  label?: string,
  origin?: string,
): SessionDescriptor {
  return registry.spawnAgent({
    workspaceSlug: "w",
    cwd: "/tmp",
    agentSession: fakeAgentSession(),
    adapterSlug: "mock",
    ...(parentSessionId ? { parentSessionId } : {}),
    depth,
    ...(label ? { label } : {}),
    ...(origin ? { origin } : {}),
  })
}

/** Parse JSON from the first text block of a tool result. */
function payload<T = Record<string, unknown>>(result: unknown): T {
  const content = (result as { content: Array<{ text: string }> }).content
  return JSON.parse(content[0]!.text) as T
}

interface Harness {
  client: Client
  registry: SessionsRegistry
  scopeTokens: ScopeTokenRegistry
  close: () => Promise<void>
}

async function buildHarness(opts?: {
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
    port: 18790,
  })
  const callerScope = opts?.caller?.(scopeTokens, registry)

  const { server } = await createMcpServer({ specs: [], name: "test", version: "0" })
  registerSessionTools(server, {
    registry,
    ...(callerScope ? { callerScope } : {}),
    buildOrchestratorMcp: injector,
  })

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "test", version: "0.0.1" })
  await client.connect(clientTransport)

  return {
    client,
    registry,
    scopeTokens,
    close: async () => { await client.close() },
  }
}

// ── (a) buildSessionTree unit tests ──────────────────────────────────────────

describe("buildSessionTree", () => {
  it("returns an empty array for an empty list", () => {
    expect(buildSessionTree([])).toEqual([])
  })

  it("single session with no parent is a root node with no children", () => {
    const sessionEvents = createSessionEventBus()
    const registry = createSessionsRegistry({ sessionEvents, persist: false })
    const s = spawnNode(registry)
    const tree = buildSessionTree([s])
    expect(tree).toHaveLength(1)
    const root = tree[0]!
    expect(root.id).toBe(s.id)
    expect(root.depth).toBe(0)
    expect(root.isOrchestrator).toBe(false)
    expect(root.children).toHaveLength(0)
  })

  it("two-level tree: root → child", () => {
    const sessionEvents = createSessionEventBus()
    const registry = createSessionsRegistry({ sessionEvents, persist: false })
    const root = spawnNode(registry, undefined, 0, "root")
    const child = spawnNode(registry, root.id, 1, "child")

    const all = registry.list()
    const tree = buildSessionTree(all)

    expect(tree).toHaveLength(1)
    const rootNode = tree[0]!
    expect(rootNode.id).toBe(root.id)
    expect(rootNode.isOrchestrator).toBe(true)
    expect(rootNode.children).toHaveLength(1)
    const childNode = rootNode.children[0]!
    expect(childNode.id).toBe(child.id)
    expect(childNode.depth).toBe(1)
    expect(childNode.isOrchestrator).toBe(false)
    expect(childNode.children).toHaveLength(0)
  })

  it("three-level tree: root → child → grandchild", () => {
    const sessionEvents = createSessionEventBus()
    const registry = createSessionsRegistry({ sessionEvents, persist: false })
    const root = spawnNode(registry, undefined, 0)
    const child = spawnNode(registry, root.id, 1)
    const grand = spawnNode(registry, child.id, 2)

    const tree = buildSessionTree(registry.list())
    expect(tree).toHaveLength(1)

    const rootNode = tree[0]!
    expect(rootNode.isOrchestrator).toBe(true)
    expect(rootNode.children).toHaveLength(1)

    const childNode = rootNode.children[0]!
    expect(childNode.id).toBe(child.id)
    expect(childNode.isOrchestrator).toBe(true)
    expect(childNode.children).toHaveLength(1)

    const grandNode = childNode.children[0]!
    expect(grandNode.id).toBe(grand.id)
    expect(grandNode.depth).toBe(2)
    expect(grandNode.isOrchestrator).toBe(false)
    expect(grandNode.children).toHaveLength(0)
  })

  it("two independent roots with separate subtrees", () => {
    const sessionEvents = createSessionEventBus()
    const registry = createSessionsRegistry({ sessionEvents, persist: false })
    const r1 = spawnNode(registry, undefined, 0, "root-1")
    const r2 = spawnNode(registry, undefined, 0, "root-2")
    spawnNode(registry, r1.id, 1)
    spawnNode(registry, r2.id, 1)

    const tree = buildSessionTree(registry.list())
    expect(tree).toHaveLength(2)

    const n1 = tree.find(n => n.id === r1.id)!
    const n2 = tree.find(n => n.id === r2.id)!
    expect(n1.children).toHaveLength(1)
    expect(n2.children).toHaveLength(1)
    // children belong to the right parent
    expect(n1.children[0]?.parentSessionId).toBe(r1.id)
    expect(n2.children[0]?.parentSessionId).toBe(r2.id)
  })

  it("node fields: id, label, status, depth, adapterSlug, parentSessionId present", () => {
    const sessionEvents = createSessionEventBus()
    const registry = createSessionsRegistry({ sessionEvents, persist: false })
    const root = spawnNode(registry, undefined, 0, "my-label")
    const child = spawnNode(registry, root.id, 1)

    const tree = buildSessionTree(registry.list())
    const rootNode = tree[0]!
    expect(rootNode.label).toBe("my-label")
    expect(rootNode.status).toBe("running")
    expect(rootNode.adapterSlug).toBe("mock")
    expect(rootNode.parentSessionId).toBeUndefined()

    const childNode = rootNode.children[0]!
    expect(childNode.parentSessionId).toBe(root.id)
    expect(childNode.id).toBe(child.id)
  })

  it("carries the descriptor's origin onto the node", () => {
    const sessionEvents = createSessionEventBus()
    const registry = createSessionsRegistry({ sessionEvents, persist: false })
    spawnNode(registry, undefined, 0, "root", "vscode")
    const tree = buildSessionTree(registry.list())
    expect(tree[0]!.origin).toBe("vscode")
  })
})

// ── (a2) groupRootsByOrigin — origin bucketing of roots ──────────────────────

describe("groupRootsByOrigin", () => {
  it("buckets roots by origin, preserving each subtree", () => {
    const sessionEvents = createSessionEventBus()
    const registry = createSessionsRegistry({ sessionEvents, persist: false })
    const desktop = spawnNode(registry, undefined, 0, "desktop-root", "claude-code")
    spawnNode(registry, desktop.id, 1, "desktop-child")
    spawnNode(registry, undefined, 0, "vscode-root", "vscode")

    const groups = groupRootsByOrigin(buildSessionTree(registry.list()))
    const byKey = new Map(groups.map(g => [g.origin, g]))
    expect(byKey.get("claude-code")!.sessions).toHaveLength(1)
    // the desktop root keeps its child nested inside its bucket
    expect(byKey.get("claude-code")!.sessions[0]!.children).toHaveLength(1)
    expect(byKey.get("vscode")!.sessions).toHaveLength(1)
  })

  it("groups originless roots under UNKNOWN_ORIGIN rather than dropping them", () => {
    const sessionEvents = createSessionEventBus()
    const registry = createSessionsRegistry({ sessionEvents, persist: false })
    spawnNode(registry, undefined, 0, "orphan-a")
    spawnNode(registry, undefined, 0, "orphan-b")

    const groups = groupRootsByOrigin(buildSessionTree(registry.list()))
    expect(groups).toHaveLength(1)
    expect(groups[0]!.origin).toBe(UNKNOWN_ORIGIN)
    expect(groups[0]!.sessions).toHaveLength(2)
  })

  it("only top-level roots are bucketed — children keep nesting under parents", () => {
    const sessionEvents = createSessionEventBus()
    const registry = createSessionsRegistry({ sessionEvents, persist: false })
    const root = spawnNode(registry, undefined, 0, "root", "cron")
    // child with a DIFFERENT origin must NOT surface as its own bucket
    spawnNode(registry, root.id, 1, "child", "vscode")

    const groups = groupRootsByOrigin(buildSessionTree(registry.list()))
    expect(groups.map(g => g.origin)).toEqual(["cron"])
    expect(groups[0]!.sessions[0]!.children).toHaveLength(1)
  })
})

// ── (b) session_tree MCP tool — scoped token (only subtree) ──────────────────

describe("session_tree tool — scoped caller", () => {
  it("returns only the caller's subtree, not siblings or unrelated sessions", async () => {
    // Pre-build a tree: root → caller, root → sibling; caller → child.
    // The scoped token is bound to `caller`.
    const { client, registry, scopeTokens, close } = await buildHarness({
      caller(scopeTokens, registry) {
        const rootSession = spawnNode(registry, undefined, 0, "root")
        const callerSession = spawnNode(registry, rootSession.id, 1, "caller")
        spawnNode(registry, rootSession.id, 1, "sibling")
        spawnNode(registry, callerSession.id, 2, "caller-child")

        // Mint + bind a scope for `callerSession`.
        const scope = scopeTokens.mint({ depth: 1 })
        scopeTokens.bindOwner(scope.token, callerSession.id)
        return scope
      },
    })

    try {
      const result = await client.callTool({ name: "session_tree", arguments: {} })
      const { tree } = payload<{ tree: SessionTreeNode[] }>(result)

      // Only the caller and its child — root and sibling excluded.
      const allIds = flattenTree(tree)
      const allLabels = registry.list().map(s => s.label).filter(Boolean)

      // caller and caller-child must appear
      expect(allIds.some(n => n.label === "caller")).toBe(true)
      expect(allIds.some(n => n.label === "caller-child")).toBe(true)
      // root and sibling must NOT appear
      expect(allIds.some(n => n.label === "root")).toBe(false)
      expect(allIds.some(n => n.label === "sibling")).toBe(false)
      void allLabels // just using registry to confirm labels; suppress unused warning
    } finally {
      await close()
    }
  })

  it("caller with no children returns a single-node tree", async () => {
    const { client, scopeTokens, registry, close } = await buildHarness({
      caller(scopeTokens, registry) {
        const callerSession = spawnNode(registry, undefined, 0, "lone-caller")
        const scope = scopeTokens.mint({ depth: 0 })
        scopeTokens.bindOwner(scope.token, callerSession.id)
        return scope
      },
    })

    try {
      const result = await client.callTool({ name: "session_tree", arguments: {} })
      const { tree } = payload<{ tree: SessionTreeNode[] }>(result)
      expect(tree).toHaveLength(1)
      expect(tree[0]!.label).toBe("lone-caller")
      expect(tree[0]!.children).toHaveLength(0)
    } finally {
      await close()
    }
  })
})

// ── (c) session_tree MCP tool — no scope (full tree) ─────────────────────────

describe("session_tree tool — no scope (root /mcp)", () => {
  it("returns ALL sessions in tree form", async () => {
    const { client, registry, close } = await buildHarness()

    try {
      // Seed a small 3-level tree directly in the registry.
      const r = spawnNode(registry, undefined, 0, "root")
      const c = spawnNode(registry, r.id, 1, "child")
      spawnNode(registry, c.id, 2, "grandchild")
      // Plus an unrelated root.
      spawnNode(registry, undefined, 0, "other-root")

      const result = await client.callTool({ name: "session_tree", arguments: {} })
      const { tree } = payload<{ tree: SessionTreeNode[] }>(result)

      const allNodes = flattenTree(tree)
      expect(allNodes).toHaveLength(4)

      const labels = allNodes.map(n => n.label).sort()
      expect(labels).toEqual(["child", "grandchild", "other-root", "root"].sort())

      // root is an orchestrator, child is an orchestrator, grandchild is not
      const rootNode = allNodes.find(n => n.label === "root")!
      const childNode = allNodes.find(n => n.label === "child")!
      const grandNode = allNodes.find(n => n.label === "grandchild")!
      expect(rootNode.isOrchestrator).toBe(true)
      expect(childNode.isOrchestrator).toBe(true)
      expect(grandNode.isOrchestrator).toBe(false)
    } finally {
      await close()
    }
  })

  it("onlyAlive filter prunes terminated sessions", async () => {
    const { client, registry, close } = await buildHarness()

    try {
      const alive = spawnNode(registry, undefined, 0, "alive")
      const dead = spawnNode(registry, undefined, 0, "dead")
      // Kill the dead session so its status is "killed".
      registry.kill(dead.id)

      const result = await client.callTool({
        name: "session_tree",
        arguments: { onlyAlive: true },
      })
      const { tree } = payload<{ tree: SessionTreeNode[] }>(result)

      const allNodes = flattenTree(tree)
      expect(allNodes).toHaveLength(1)
      expect(allNodes[0]!.label).toBe("alive")
      void alive // used
    } finally {
      await close()
    }
  })
})

// ── (d) session_tree tool — groupByOrigin (PR-6) ─────────────────────────────

describe("session_tree tool — groupByOrigin (PR-6)", () => {
  it("default still includes the byOrigin companion view", async () => {
    const { client, registry, close } = await buildHarness()

    try {
      const desktop = spawnNode(registry, undefined, 0, "desktop-root", "claude-code")
      spawnNode(registry, desktop.id, 1, "desktop-child")
      spawnNode(registry, undefined, 0, "vscode-root", "vscode")

      const result = await client.callTool({ name: "session_tree", arguments: {} })
      const body = payload<{
        tree: SessionTreeNode[]
        byOrigin: ReturnType<typeof groupRootsByOrigin>
      }>(result)

      expect("byOrigin" in body).toBe(true)
      expect(body.tree).toHaveLength(2)
      const byKey = new Map(body.byOrigin.map(g => [g.origin, g]))
      expect(byKey.get("claude-code")!.sessions).toHaveLength(1)
      expect(byKey.get("vscode")!.sessions).toHaveLength(1)
    } finally {
      await close()
    }
  })

  it("groupByOrigin:false suppresses byOrigin but leaves the tree intact", async () => {
    const { client, registry, close } = await buildHarness()

    try {
      const root = spawnNode(registry, undefined, 0, "root", "cron")
      spawnNode(registry, root.id, 1, "child")

      const result = await client.callTool({
        name: "session_tree",
        arguments: { groupByOrigin: false },
      })
      const body = payload<{ tree: SessionTreeNode[]; byOrigin?: unknown }>(result)

      expect("byOrigin" in body).toBe(false)
      expect(body.tree).toHaveLength(1)
      expect(body.tree[0]!.label).toBe("root")
      expect(body.tree[0]!.children).toHaveLength(1)
      expect(body.tree[0]!.children[0]!.label).toBe("child")
    } finally {
      await close()
    }
  })

  it("groupByOrigin:true explicitly keeps byOrigin", async () => {
    const { client, registry, close } = await buildHarness()

    try {
      spawnNode(registry, undefined, 0, "root", "vscode")

      const result = await client.callTool({
        name: "session_tree",
        arguments: { groupByOrigin: true },
      })
      const body = payload<{
        tree: SessionTreeNode[]
        byOrigin?: ReturnType<typeof groupRootsByOrigin>
      }>(result)
      expect("byOrigin" in body).toBe(true)
      expect(body.byOrigin).toHaveLength(1)
      expect(body.byOrigin![0]!.origin).toBe("vscode")
    } finally {
      await close()
    }
  })
})

// ── (e) session_tree tool — nodeId/direction navigation ──────────────────────

describe("session_tree tool — nodeId/direction navigation", () => {
  /** Seed: root → (a, b), a → (a1, a2), a1 → (a1x). Returns descriptors by label. */
  async function seedNavTree() {
    const harness = await buildHarness()
    const { registry } = harness
    const root = spawnNode(registry, undefined, 0, "root")
    const a = spawnNode(registry, root.id, 1, "a")
    const b = spawnNode(registry, root.id, 1, "b")
    const a1 = spawnNode(registry, a.id, 2, "a1")
    const a2 = spawnNode(registry, a.id, 2, "a2")
    const a1x = spawnNode(registry, a1.id, 3, "a1x")
    const byLabel = Object.fromEntries(
      [root, a, b, a1, a2, a1x].map(s => [s.label!, s]),
    ) as Record<string, SessionDescriptor>
    return { ...harness, root, a, b, a1, a2, a1x, byLabel }
  }

  it("children returns direct children only, one level", async () => {
    const { client, close, byLabel } = await seedNavTree()
    try {
      const result = await client.callTool({
        name: "session_tree",
        arguments: { nodeId: byLabel.a!.id, direction: "children" },
      })
      const { children } = payload<{ children: SessionTreeNode[] }>(result)
      expect(children.map(c => c.label).sort()).toEqual(["a1", "a2"])
      expect(children.every(c => c.children.length === 0)).toBe(true)
    } finally {
      await close()
    }
  })

  it("parent returns the single parent, or null for a root", async () => {
    const { client, close, byLabel } = await seedNavTree()
    try {
      const child = await client.callTool({
        name: "session_tree",
        arguments: { nodeId: byLabel.a1!.id, direction: "parent" },
      })
      const { parent } = payload<{ parent: SessionTreeNode | null }>(child)
      expect(parent?.label).toBe("a")

      const rootRes = await client.callTool({
        name: "session_tree",
        arguments: { nodeId: byLabel.root!.id, direction: "parent" },
      })
      expect(payload<{ parent: SessionTreeNode | null }>(rootRes).parent).toBeNull()
    } finally {
      await close()
    }
  })

  it("siblings excludes the node itself and other parents' children", async () => {
    const { client, close, byLabel } = await seedNavTree()
    try {
      const result = await client.callTool({
        name: "session_tree",
        arguments: { nodeId: byLabel.a!.id, direction: "siblings" },
      })
      const { siblings } = payload<{ siblings: SessionTreeNode[] }>(result)
      expect(siblings.map(s => s.label)).toEqual(["b"])

      // A root has no parent → no siblings.
      const rootRes = await client.callTool({
        name: "session_tree",
        arguments: { nodeId: byLabel.root!.id, direction: "siblings" },
      })
      expect(payload<{ siblings: SessionTreeNode[] }>(rootRes).siblings).toEqual([])
    } finally {
      await close()
    }
  })

  it("ancestors returns the nearest-first chain up to the root, honoring depth", async () => {
    const { client, close, byLabel } = await seedNavTree()
    try {
      const full = await client.callTool({
        name: "session_tree",
        arguments: { nodeId: byLabel.a1x!.id, direction: "ancestors" },
      })
      const { ancestors } = payload<{ ancestors: SessionTreeNode[] }>(full)
      expect(ancestors.map(n => n.label)).toEqual(["a1", "a", "root"])

      const capped = await client.callTool({
        name: "session_tree",
        arguments: { nodeId: byLabel.a1x!.id, direction: "ancestors", depth: 1 },
      })
      expect(
        payload<{ ancestors: SessionTreeNode[] }>(capped).ancestors.map(n => n.label),
      ).toEqual(["a1"])
    } finally {
      await close()
    }
  })

  it("descendants returns the node's subtree; depth caps the walk", async () => {
    const { client, close, byLabel } = await seedNavTree()
    try {
      const full = await client.callTool({
        name: "session_tree",
        arguments: { nodeId: byLabel.a!.id, direction: "descendants" },
      })
      const { tree } = payload<{ tree: SessionTreeNode[] }>(full)
      expect(tree).toHaveLength(1)
      expect(tree[0]!.label).toBe("a")
      const flat = flattenTree(tree)
      expect(flat.map(n => n.label).sort()).toEqual(
        ["a", "a1", "a1x", "a2"].sort(),
      )
      // depth preserved from the descriptors
      expect(tree[0]!.depth).toBe(1)
      expect(tree[0]!.children[0]!.depth).toBe(2)

      const capped = await client.callTool({
        name: "session_tree",
        arguments: { nodeId: byLabel.a!.id, direction: "descendants", depth: 1 },
      })
      const cappedTree = payload<{ tree: SessionTreeNode[] }>(capped).tree
      expect(flattenTree(cappedTree).map(n => n.label).sort()).toEqual(
        ["a", "a1", "a2"].sort(),
      )
    } finally {
      await close()
    }
  })

  it("direction without nodeId is a validation error, not a silent full dump", async () => {
    const { client, close } = await seedNavTree()
    try {
      const result = await client.callTool({
        name: "session_tree",
        arguments: { direction: "children" },
      })
      expect((result as { isError?: boolean }).isError).toBe(true)
      expect(payload<{ error: string }>(result).error).toContain("together")
    } finally {
      await close()
    }
  })

  it("nodeId without direction is a validation error", async () => {
    const { client, close, byLabel } = await seedNavTree()
    try {
      const result = await client.callTool({
        name: "session_tree",
        arguments: { nodeId: byLabel.a!.id },
      })
      expect((result as { isError?: boolean }).isError).toBe(true)
      expect(payload<{ error: string }>(result).error).toContain("together")
    } finally {
      await close()
    }
  })

  it("unknown nodeId returns a clear error, not an empty tree", async () => {
    const { client, close } = await seedNavTree()
    try {
      const result = await client.callTool({
        name: "session_tree",
        arguments: { nodeId: "no-such-session", direction: "children" },
      })
      expect((result as { isError?: boolean }).isError).toBe(true)
      expect(payload<{ error: string }>(result).error).toContain("no-such-session")
    } finally {
      await close()
    }
  })

  it("regression: omitting both params returns the exact full-dump shape", async () => {
    const { client, registry, close } = await seedNavTree()
    try {
      const result = await client.callTool({ name: "session_tree", arguments: {} })
      const body = payload<{
        tree: SessionTreeNode[]
        byOrigin: ReturnType<typeof groupRootsByOrigin>
      }>(result)
      // Byte-comparable with the pre-navigation full dump.
      expect(body).toEqual({
        tree: buildSessionTree(registry.list({ includeArchived: true })),
        byOrigin: groupRootsByOrigin(
          buildSessionTree(registry.list({ includeArchived: true })),
        ),
      })
    } finally {
      await close()
    }
  })
})

// ── utility ───────────────────────────────────────────────────────────────────

/** Flatten a SessionTreeNode[] tree into a flat array for easier assertions. */
function flattenTree(nodes: SessionTreeNode[]): SessionTreeNode[] {
  const result: SessionTreeNode[] = []
  const queue = [...nodes]
  while (queue.length > 0) {
    const n = queue.shift()!
    result.push(n)
    queue.push(...n.children)
  }
  return result
}

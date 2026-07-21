/**
 * Unit coverage for the session-lineage runtime foundation (WP-R1 + WP-R3):
 *
 *   - the trusted `parentSessionId` lineage hint on `spawnAgentSession` — the
 *     anonymous root path honours it (filling the depth-0-orphan gap for an
 *     agent-to-agent spawn), while the scoped orchestrator path IGNORES it and
 *     the unspoofable scope token always wins;
 *   - `depth` is DERIVED from the resolved parent descriptor (parent + 1,
 *     defaulting to 1 when the parent isn't registered), never trusted from the
 *     caller;
 *   - a `session:spawned` bus event is emitted at registration carrying the
 *     right lineage shape.
 *
 * Calls `spawnAgentSession` / the registry directly (no MCP transport) — cheap,
 * focused checks of the resolution logic and the emission.
 */

import { describe, it, expect, vi } from "vitest"

// Deterministic `~/.agentproto/workspaces.json` — a spawn with an explicit cwd
// but no slug still calls `loadWorkspacesConfig` to try to match a workspace.
// Pin it to empty so these tests never touch the real file on the host.
const wsConfigState = vi.hoisted(() => ({
  value: { version: 1, workspaces: [] } as import("../workspaces-config.js").WorkspacesConfig,
}))
vi.mock("../workspaces-config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../workspaces-config.js")>()
  return { ...actual, loadWorkspacesConfig: vi.fn(async () => wsConfigState.value) }
})

import { spawnAgentSession, type SpawnAgentSessionDeps } from "../session-spawn.js"
import {
  createSessionsRegistry,
  type SessionsRegistry,
  type AgentSessionLike,
  type AgentStreamEvent,
} from "../sessions.js"
import {
  createSessionEventBus,
  type SessionEvent,
  type SessionSpawnedEvent,
} from "../session-event-bus.js"
import { createScopeTokenRegistry } from "../orchestrator-gateway.js"
import type { AgentAdapterResolver } from "../http-server.js"

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

function makeResolver(): AgentAdapterResolver {
  return async () => ({
    startSession: vi.fn(async () => fakeAgentSession()),
    commandPreview: "mock-adapter (agent)",
  })
}

function makeDeps(
  overrides: Partial<SpawnAgentSessionDeps> = {},
): { registry: SessionsRegistry; deps: SpawnAgentSessionDeps } {
  const registry =
    (overrides.registry as SessionsRegistry) ?? createSessionsRegistry({ persist: false })
  const deps: SpawnAgentSessionDeps = {
    registry,
    resolveAgentAdapter: makeResolver(),
    ...overrides,
  }
  return { registry, deps }
}

/** Seed a tracked parent session straight through the registry at an explicit
 *  depth, so a hint can resolve against a real descriptor. */
function seedParent(registry: SessionsRegistry, depth: number): string {
  return registry.spawnAgent({
    workspaceSlug: "default",
    cwd: "/tmp",
    agentSession: fakeAgentSession(),
    adapterSlug: "mock",
    harness: "mock",
    depth,
  }).id
}

describe("session lineage — trusted parentSessionId hint (WP-R1)", () => {
  it("honours the hint on the anonymous root path and derives depth = parent + 1", async () => {
    const { registry, deps } = makeDeps()
    const parentId = seedParent(registry, 2)

    const result = await spawnAgentSession(deps, {
      adapter: "mock",
      cwd: "/tmp",
      parentSessionId: parentId,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected spawn")
    expect(result.descriptor.parentSessionId).toBe(parentId)
    expect(result.descriptor.depth).toBe(3) // parent depth (2) + 1
  })

  it("defaults hint-derived depth to 1 when the parent isn't in the registry", async () => {
    const { deps } = makeDeps()

    const result = await spawnAgentSession(deps, {
      adapter: "mock",
      cwd: "/tmp",
      parentSessionId: "sess_ghost", // never registered
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected spawn")
    expect(result.descriptor.parentSessionId).toBe("sess_ghost")
    expect(result.descriptor.depth).toBe(1)
  })

  it("leaves a plain root spawn (no hint) parentless at depth 0", async () => {
    const { deps } = makeDeps()

    const result = await spawnAgentSession(deps, { adapter: "mock", cwd: "/tmp" })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected spawn")
    expect(result.descriptor.parentSessionId).toBeUndefined()
    expect(result.descriptor.depth).toBe(0)
  })

  it("scope WINS over a hint: a scoped spawn attributes to the token owner, not the hint", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const scopeTokens = createScopeTokenRegistry()
    const scope = scopeTokens.mint({ depth: 1 })
    scopeTokens.bindOwner(scope.token, "owner-sess")
    const { deps } = makeDeps({ registry, callerScope: scope })

    const result = await spawnAgentSession(deps, {
      adapter: "mock",
      cwd: "/tmp",
      // A spoofed hint pointing anywhere else must NOT win over the scope token.
      parentSessionId: "attacker-chosen-parent",
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected spawn")
    expect(result.descriptor.parentSessionId).toBe("owner-sess")
    // Depth comes from the scope (caller depth 1 + 1), NOT the hint parent.
    expect(result.descriptor.depth).toBe(2)
  })

  it("ignores the hint on the scoped path even when the scope has no bound owner yet", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const scopeTokens = createScopeTokenRegistry()
    // Minted but not yet bound → ownerSessionId is undefined. The hint must
    // still be ignored (the scoped trust boundary never consults it), so the
    // child is parentless rather than adopting the caller-supplied hint.
    const scope = scopeTokens.mint({ depth: 0 })
    const { deps } = makeDeps({ registry, callerScope: scope })

    const result = await spawnAgentSession(deps, {
      adapter: "mock",
      cwd: "/tmp",
      parentSessionId: "attacker-chosen-parent",
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected spawn")
    expect(result.descriptor.parentSessionId).toBeUndefined()
    expect(result.descriptor.depth).toBe(1) // scope depth (0) + 1
  })
})

describe("session lineage — session:spawned event (WP-R3)", () => {
  it("emits session:spawned at registration with the hinted parent + derived depth", async () => {
    const sessionEvents = createSessionEventBus()
    const registry = createSessionsRegistry({ persist: false, sessionEvents })
    const events: SessionSpawnedEvent[] = []
    sessionEvents.on("session:spawned", (ev) => events.push(ev))

    const parentId = seedParent(registry, 2)
    const { deps } = makeDeps({ registry })

    const result = await spawnAgentSession(deps, {
      adapter: "mock",
      cwd: "/tmp",
      label: "child-agent",
      parentSessionId: parentId,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected spawn")

    // The parent's own registration also emits; select the child's event.
    const childEvt = events.find((e) => e.sessionId === result.descriptor.id)
    expect(childEvt).toBeDefined()
    expect(childEvt).toMatchObject({
      type: "session:spawned",
      sessionId: result.descriptor.id,
      parentSessionId: parentId,
      label: "child-agent",
      depth: 3,
    })
    expect(typeof childEvt!.ts).toBe("string")
  })

  it("emits session:spawned for a root spawn with depth 0 and no parentSessionId", async () => {
    const sessionEvents = createSessionEventBus()
    const registry = createSessionsRegistry({ persist: false, sessionEvents })
    const seen: SessionEvent[] = []
    sessionEvents.onAny((ev) => seen.push(ev))

    const { deps } = makeDeps({ registry })
    const result = await spawnAgentSession(deps, { adapter: "mock", cwd: "/tmp" })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected spawn")

    const evt = seen.find(
      (e): e is SessionSpawnedEvent =>
        e.type === "session:spawned" && e.sessionId === result.descriptor.id,
    )
    expect(evt).toBeDefined()
    expect(evt!.depth).toBe(0)
    expect(evt!.parentSessionId).toBeUndefined()
  })
})

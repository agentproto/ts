/**
 * A restarted orchestrator keeps a live scope and its children.
 *
 * An orchestrator session carries an `/mcp/orchestrator?scope=<token>`
 * mount whose scope is bound to the session's id. Restarting it used to
 * close the old row (`restarted`), which revoked the token the new row
 * still carried and reaped every live child of the old id. These tests run
 * the real sessions registry, scope-token registry and injector in process
 * (stub adapter) through the three restart shapes: new id with a live old
 * row, new id after the old row crashed, and in place after a crash.
 */
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  createOrchestratorInjector,
  createOrchestratorScopeHooks,
  createScopeTokenRegistry,
  reapOrphanedDescendants,
  type OrchestratorScope,
} from "../orchestrator-gateway.js"
import { collectSubtree } from "../agent-tools.js"
import { restartAgentSession, tryRestartInPlace } from "../session-restart-core.js"
import {
  createSessionsRegistry,
  type AgentSessionLike,
  type AgentStreamEvent,
  type SessionDescriptor,
} from "../sessions.js"
import { createSessionEventBus, type SessionEvent } from "../session-event-bus.js"
import type { AgentAdapterResolver } from "../http-server.js"

let counter = 0
function fakeAgentSession(): AgentSessionLike {
  return {
    sessionId: `acp_orch_restart_${counter++}`,
    // eslint-disable-next-line require-yield
    async *send(): AsyncIterable<AgentStreamEvent> {},
    async cancel() {},
    async close() {},
  }
}

const resolver: AgentAdapterResolver = async () => ({
  startSession: async () => fakeAgentSession(),
  commandPreview: "mock-adapter",
})

const tokenOf = (desc: SessionDescriptor | undefined): string | null => {
  const entry = desc?.mcpServers?.find(m => m.ref?.includes("/mcp/orchestrator"))
  return entry?.ref ? new URL(entry.ref).searchParams.get("scope") : null
}

const paramsOf = (scope: OrchestratorScope) => ({
  role: scope.role,
  depth: scope.depth,
  maxDepth: scope.maxDepth,
  maxChildren: scope.maxChildren,
  tools: [...scope.tools].sort(),
})

function setup() {
  const sessionEvents = createSessionEventBus()
  const events: SessionEvent[] = []
  sessionEvents.onAny(ev => {
    events.push(ev)
  })
  const scopeTokens = createScopeTokenRegistry()
  const registry = createSessionsRegistry({
    sessionEvents,
    persist: false,
    transcriptDir: join(mkdtempSync(join(tmpdir(), "orch-restart-")), "transcripts"),
    orchestratorScopes: createOrchestratorScopeHooks(scopeTokens),
    resumeAgent: async () => fakeAgentSession(),
  })
  const injector = createOrchestratorInjector({
    scopeTokens,
    sessionEvents,
    port: 4999,
    reapChildren: id => {
      reapOrphanedDescendants(registry, id)
    },
  })
  // A narrowed, non-default scope, so "same parameters" is a real check.
  const injection = injector({
    tools: ["agent_start", "agent_prompt", "message_parent", "session_tree"],
    maxDepth: 5,
    maxChildren: 2,
    role: "supervisor",
  })
  const orchestrator = registry.spawnAgent({
    workspaceSlug: "w",
    cwd: process.cwd(),
    agentSession: fakeAgentSession(),
    adapterSlug: "mock",
    mcpServers: [injection.entry],
  })
  injection.bindLifecycle(orchestrator.id)
  const child = registry.spawnAgent({
    workspaceSlug: "w",
    cwd: process.cwd(),
    agentSession: fakeAgentSession(),
    adapterSlug: "mock",
    parentSessionId: orchestrator.id,
    depth: 1,
  })
  const before = paramsOf(injection.scope)
  return { registry, scopeTokens, injection, orchestrator, child, before, events }
}

const daemonMcpUrl = "http://127.0.0.1:4999/mcp"

describe("restarting an orchestrator session", () => {
  it("new id, live old row: the scope moves to the new id and the child stays, re-parented", async () => {
    const t = setup()
    const restarted = await restartAgentSession(t.registry, resolver, t.orchestrator, {
      forceAgentResume: true,
      daemonMcpUrl,
    })
    const next = restarted.desc
    expect(next.id).not.toBe(t.orchestrator.id)
    expect(t.registry.get(t.orchestrator.id)?.endedReason).toBe("restarted")

    // The restarted row's mount carries a scope that verifies, with the
    // same parameters, now owned by the new id.
    const token = tokenOf(t.registry.get(next.id))
    expect(token).toBe(t.injection.scope.token)
    const scope = t.scopeTokens.verify(token)
    expect(scope).not.toBeNull()
    expect(paramsOf(scope!)).toEqual(t.before)
    expect(scope!.ownerSessionId).toBe(next.id)

    // The child is still running and hangs under the restarted row: the
    // `parentSessionId` pointer every reader keys on (message_parent, the
    // drive gate, session_tree, agent_kill subtree, the orphan reaper).
    const child = t.registry.get(t.child.id)
    expect(child?.status).toBe("running")
    expect(child?.parentSessionId).toBe(next.id)
    expect(collectSubtree(next.id, t.registry.list({ includeArchived: true })).has(t.child.id)).toBe(true)
    const handover = t.events.find(ev => ev.type === "session:lineage-handover")
    expect(handover).toMatchObject({ sessionId: t.orchestrator.id, successorSessionId: next.id, adopted: [t.child.id], reason: "restart" })

    // A real exit of the restarted row still revokes and reaps.
    t.registry.kill(next.id)
    expect(t.scopeTokens.verify(token)).toBeNull()
    expect(t.registry.get(t.child.id)?.status).toBe("killed")
    expect(t.registry.get(t.child.id)?.endedReason).toBe("parent-exited")

    // The token never rides an event.
    expect(JSON.stringify(t.events)).not.toContain(t.injection.scope.token)
  })

  it("new id after the old row crashed: the scope is reinstated for the new id, the reaped child stays dead", async () => {
    const t = setup()
    expect(t.registry.markCrashed(t.orchestrator.id)).toBe(true)
    // The crash is a real exit: token revoked, child reaped.
    expect(t.scopeTokens.verify(t.injection.scope.token)).toBeNull()
    expect(t.registry.get(t.child.id)?.status).toBe("killed")

    const restarted = await restartAgentSession(
      t.registry,
      resolver,
      t.registry.get(t.orchestrator.id)!,
      { forceAgentResume: true, daemonMcpUrl },
    )
    const next = restarted.desc
    const scope = t.scopeTokens.verify(tokenOf(t.registry.get(next.id)))
    expect(scope).not.toBeNull()
    expect(paramsOf(scope!)).toEqual(t.before)
    expect(scope!.ownerSessionId).toBe(next.id)
    // Nothing is revived: the reaped child stays dead and under the old id.
    expect(t.registry.get(t.child.id)?.status).toBe("killed")
    expect(t.registry.get(t.child.id)?.parentSessionId).toBe(t.orchestrator.id)

    t.registry.kill(next.id)
    expect(t.scopeTokens.verify(t.injection.scope.token)).toBeNull()
  })

  it("in place after a crash: the same row gets its scope back, the reaped child stays dead", async () => {
    const t = setup()
    expect(t.registry.markCrashed(t.orchestrator.id)).toBe(true)
    expect(t.scopeTokens.verify(t.injection.scope.token)).toBeNull()

    const revived = await tryRestartInPlace(t.registry, t.registry.get(t.orchestrator.id)!)
    expect(revived?.id).toBe(t.orchestrator.id)
    const scope = t.scopeTokens.verify(tokenOf(revived))
    expect(scope).not.toBeNull()
    expect(paramsOf(scope!)).toEqual(t.before)
    expect(scope!.ownerSessionId).toBe(t.orchestrator.id)
    expect(t.registry.get(t.child.id)?.status).toBe("killed")

    // The next real exit revokes again.
    t.registry.kill(t.orchestrator.id)
    expect(t.scopeTokens.verify(t.injection.scope.token)).toBeNull()
  })

  it("a failed restart of a crashed row leaves its scope revoked", async () => {
    const t = setup()
    t.registry.markCrashed(t.orchestrator.id)
    const failing: AgentAdapterResolver = async () => ({
      startSession: async () => {
        throw new Error("adapter refused to start")
      },
      commandPreview: "mock-adapter",
    })
    await expect(
      restartAgentSession(t.registry, failing, t.registry.get(t.orchestrator.id)!, {
        forceAgentResume: true,
        daemonMcpUrl,
      }),
    ).rejects.toThrow()
    expect(t.scopeTokens.verify(t.injection.scope.token)).toBeNull()
  })

  it("the mcpServers override announcement never carries the scope-token", async () => {
    const t = setup()
    await restartAgentSession(t.registry, resolver, t.orchestrator, {
      forceAgentResume: true,
      daemonMcpUrl,
      overrides: { mcpServers: [t.injection.entry] },
    })
    const announced = t.events.filter(
      ev => ev.type === "session:config-changed" && ev.axis === "mcpServers",
    )
    expect(announced).toHaveLength(1)
    expect(JSON.stringify(announced)).toContain("/mcp/orchestrator")
    expect(JSON.stringify(t.events)).not.toContain(t.injection.scope.token)
  })
})

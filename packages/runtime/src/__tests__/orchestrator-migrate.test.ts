/**
 * A migrated orchestrator keeps a live scope and its children.
 *
 * `session_migrate` moves a sandbox session onto a new box through
 * continue-fresh, then closes the old row (`restarted`). The new row carries
 * the old row's `/mcp/orchestrator?scope=<token>` mount, but the scope stayed
 * owned by the old id, so closing the old row revoked the token the new row
 * still carried, and the new row's own exit later revoked and reaped nothing.
 * These tests run the real sessions registry, scope-token registry, injector,
 * continue-fresh and migrate in process; only the box boot is stubbed.
 */
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  createOrchestratorInjector,
  createOrchestratorScopeHooks,
  createScopeTokenRegistry,
  reapOrphanedDescendants,
  type OrchestratorScope,
} from "../orchestrator-gateway.js"
import { collectSubtree } from "../agent-tools.js"
import { migrateSandboxSession, type SessionMigrateDeps } from "../session-migrate.js"
import { resetContinueFreshMemoForTests } from "../session-continue-fresh.js"
import type { SandboxDeliveryRecord } from "../sandbox-delivery.js"
import {
  createSessionsRegistry,
  type AgentSessionLike,
  type AgentStreamEvent,
  type SessionDescriptor,
  type SessionsRegistry,
} from "../sessions.js"
import { createSessionEventBus, type SessionEvent } from "../session-event-bus.js"
import type { WorkspacesConfig } from "../workspaces-config.js"

vi.mock("../session-spawn.js", async importOriginal => {
  const mod = await importOriginal<typeof import("../session-spawn.js")>()
  return { ...mod, spawnAgentSession: vi.fn() }
})

import { spawnAgentSession } from "../session-spawn.js"

let counter = 0
function fakeAgentSession(): AgentSessionLike {
  return {
    sessionId: `acp_orch_migrate_${counter++}`,
    // eslint-disable-next-line require-yield
    async *send(): AsyncIterable<AgentStreamEvent> {},
    async cancel() {},
    async close() {},
  }
}

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

const checkpointRecord = (): SandboxDeliveryRecord => ({
  at: "2026-10-29T10:00:00.000Z",
  branch: "wt/feat",
  baseSha: "b".repeat(40),
  ahead: 1,
  uncommittedFiles: 0,
  mode: "checkpoint",
  push: { status: "pushed" },
  key: "k1",
  bundle: { status: "skipped" },
})

const workspaces = {
  workspaces: [{ slug: "repo", path: "/tmp/repo", remote: { url: "https://github.com/acme/repo.git" } }],
} as unknown as WorkspacesConfig

/** Lay the sandbox facets `assessMigration` checks over a registry row. */
function asSandboxRow(desc: SessionDescriptor, sandboxId: string): void {
  Object.assign(desc, {
    remote: true,
    sandboxId,
    sandboxProvider: "e2b",
    command: "sandbox:e2b → mock",
    sandboxDeliveryTarget: { checkoutDir: "/home/user/repo", branch: "wt/feat", baseSha: "b".repeat(40) },
    sandboxCheckpoint: checkpointRecord(),
    contextContinuity: {
      mode: "auto",
      warnAtPct: 55,
      compactAtPct: 65,
      continueFreshAtPct: 75,
      hardStopAtPct: 90,
      goal: true,
      plan: true,
      decisions: true,
      changedFiles: true,
      gitStatus: true,
      tests: true,
      errors: true,
      risks: true,
      nextStep: true,
      config: true,
      label: "auto",
    },
  })
}

/** The new box's spawn: a row on the same registry, with the mounts and
 *  parent the continuation handed over. */
function stubBoxBoot(registry: SessionsRegistry): void {
  vi.mocked(spawnAgentSession).mockImplementation(async (_deps, input) => {
    const desc = registry.spawnAgent({
      workspaceSlug: input.workspaceSlug ?? "repo",
      cwd: process.cwd(),
      agentSession: fakeAgentSession(),
      adapterSlug: "mock",
      ...(input.mcpServers ? { mcpServers: input.mcpServers } : {}),
      ...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}),
    })
    asSandboxRow(desc, "box_new")
    return { ok: true, descriptor: desc }
  })
}

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
    transcriptDir: join(mkdtempSync(join(tmpdir(), "orch-migrate-")), "transcripts"),
    orchestratorScopes: createOrchestratorScopeHooks(scopeTokens),
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
    workspaceSlug: "repo",
    cwd: process.cwd(),
    agentSession: fakeAgentSession(),
    adapterSlug: "mock",
    mcpServers: [injection.entry],
  })
  asSandboxRow(orchestrator, "box_old")
  injection.bindLifecycle(orchestrator.id)
  const child = registry.spawnAgent({
    workspaceSlug: "repo",
    cwd: process.cwd(),
    agentSession: fakeAgentSession(),
    adapterSlug: "mock",
    parentSessionId: orchestrator.id,
    depth: 1,
  })
  const deps = {
    registry,
    resolveAgentAdapter: vi.fn(),
    loadWorkspaces: async () => workspaces,
    loadDefaultsConfig: async () => undefined,
    // The old box answers with a delivered checkpoint.
    finalCheckpoint: async () => checkpointRecord(),
  } as unknown as SessionMigrateDeps
  const baseDir = mkdtempSync(join(tmpdir(), "orch-migrate-ckpt-"))
  return { registry, scopeTokens, injection, orchestrator, child, deps, baseDir, events, before: paramsOf(injection.scope) }
}

describe("migrating an orchestrator session", () => {
  beforeEach(() => {
    resetContinueFreshMemoForTests()
    vi.mocked(spawnAgentSession).mockReset()
  })

  it("the scope moves to the migrated session, the child stays, and a real exit still revokes and reaps", async () => {
    const t = setup()
    stubBoxBoot(t.registry)
    const result = await migrateSandboxSession(t.deps, t.orchestrator, { baseDir: t.baseDir })
    const next = result.descriptor
    expect(next.id).not.toBe(t.orchestrator.id)
    expect(result.oldSessionKilled).toBe(true)
    expect(t.registry.get(t.orchestrator.id)?.endedReason).toBe("restarted")

    // The migrated row's mount carries a scope that verifies, with the same
    // parameters, now owned by the migrated id.
    const token = tokenOf(t.registry.get(next.id))
    expect(token).toBe(t.injection.scope.token)
    const scope = t.scopeTokens.verify(token)
    expect(scope).not.toBeNull()
    expect(paramsOf(scope!)).toEqual(t.before)
    expect(scope!.ownerSessionId).toBe(next.id)

    // The child is still running and hangs under the migrated row: the
    // `parentSessionId` pointer message_parent, session_tree, the agent_kill
    // subtree and the orphan reaper all read.
    const child = t.registry.get(t.child.id)
    expect(child?.status).toBe("running")
    expect(child?.parentSessionId).toBe(next.id)
    expect(collectSubtree(next.id, t.registry.list({ includeArchived: true })).has(t.child.id)).toBe(true)
    expect(collectSubtree(t.orchestrator.id, t.registry.list({ includeArchived: true })).has(t.child.id)).toBe(false)

    // A real exit of the migrated row still revokes and reaps.
    t.registry.kill(next.id)
    expect(t.scopeTokens.verify(token)).toBeNull()
    expect(t.registry.get(t.child.id)?.status).toBe("killed")
    expect(t.registry.get(t.child.id)?.endedReason).toBe("parent-exited")

    // The token never rides an event.
    expect(JSON.stringify(t.events)).not.toContain(t.injection.scope.token)
  })

  it("a box that crashed: the scope is reinstated for the migrated session", async () => {
    const t = setup()
    expect(t.registry.markCrashed(t.orchestrator.id)).toBe(true)
    // The crash is a real exit: token revoked, child reaped.
    expect(t.scopeTokens.verify(t.injection.scope.token)).toBeNull()
    expect(t.registry.get(t.child.id)?.status).toBe("killed")

    stubBoxBoot(t.registry)
    const result = await migrateSandboxSession(t.deps, t.registry.get(t.orchestrator.id)!, { baseDir: t.baseDir })
    const next = result.descriptor
    expect(result.oldSessionKilled).toBe(false)
    const scope = t.scopeTokens.verify(tokenOf(t.registry.get(next.id)))
    expect(scope).not.toBeNull()
    expect(paramsOf(scope!)).toEqual(t.before)
    expect(scope!.ownerSessionId).toBe(next.id)
    // Nothing is revived: the reaped child stays dead.
    expect(t.registry.get(t.child.id)?.status).toBe("killed")

    t.registry.kill(next.id)
    expect(t.scopeTokens.verify(t.injection.scope.token)).toBeNull()
  })

  it("a migration whose new box fails to spawn leaves the scope and the child with the old owner", async () => {
    const t = setup()
    vi.mocked(spawnAgentSession).mockResolvedValue({
      ok: false,
      code: "sandbox_proxy_failed",
      message: "box refused to boot",
    } as never)
    await expect(migrateSandboxSession(t.deps, t.orchestrator, { baseDir: t.baseDir })).rejects.toThrow(
      /box refused to boot/,
    )
    const scope = t.scopeTokens.verify(t.injection.scope.token)
    expect(scope).not.toBeNull()
    expect(scope!.ownerSessionId).toBe(t.orchestrator.id)
    expect(t.registry.get(t.orchestrator.id)?.status).toBe("running")
    expect(t.registry.get(t.child.id)?.parentSessionId).toBe(t.orchestrator.id)

    // The old owner's real exit still revokes and reaps.
    t.registry.kill(t.orchestrator.id)
    expect(t.scopeTokens.verify(t.injection.scope.token)).toBeNull()
    expect(t.registry.get(t.child.id)?.endedReason).toBe("parent-exited")
  })

  it("a crashed box whose migration fails: the reinstated scope is revoked again, owned by the old id", async () => {
    const t = setup()
    t.registry.markCrashed(t.orchestrator.id)
    vi.mocked(spawnAgentSession).mockResolvedValue({
      ok: false,
      code: "sandbox_proxy_failed",
      message: "box refused to boot",
    } as never)
    await expect(
      migrateSandboxSession(t.deps, t.registry.get(t.orchestrator.id)!, { baseDir: t.baseDir }),
    ).rejects.toThrow()
    expect(t.scopeTokens.verify(t.injection.scope.token)).toBeNull()
    // Still the old id's to bring back: a later restart of it reinstates it.
    expect(t.scopeTokens.reinstate(t.orchestrator.id).map(paramsOf)).toEqual([t.before])
  })
})

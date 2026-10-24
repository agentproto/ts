import { describe, expect, it, vi } from "vitest"

import type { AcpMcpServer } from "@agentproto/acp"

const storeKeys = vi.hoisted(() => ({ value: {} as Record<string, string | undefined> }))
vi.mock("../providers-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../providers-store.js")>()
  return { ...actual, getProviderKey: vi.fn(async (p: string) => storeKeys.value[p]) }
})

const wsConfigState = vi.hoisted(() => ({
  value: { version: 1, workspaces: [] } as import("../workspaces-config.js").WorkspacesConfig,
}))
vi.mock("../workspaces-config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../workspaces-config.js")>()
  return { ...actual, loadWorkspacesConfig: vi.fn(async () => wsConfigState.value) }
})

import {
  spawnAgentSession,
  type SpawnAgentSessionDeps,
} from "../session-spawn.js"
import {
  createSessionsRegistry,
  type AgentSessionLike,
  type AgentStreamEvent,
} from "../sessions.js"
import { cdContractLine } from "../agents-md.js"
import type { AgentAdapterResolver } from "../http-server.js"
import type {
  WorktreeIsolationMode,
  WorktreeProvisioner,
  WorktreeProvisionOutcome,
} from "../worktree-isolation.js"

type ObservedAdmission = {
  stage: string
  decision: {
    outcome: string
    code?: string
    message?: string
    targetId?: string
  }
  dedupeSource?: string
  label?: string
}

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

function makeResolver(
  startSession: (...args: any[]) => Promise<AgentSessionLike>,
): AgentAdapterResolver {
  return async () => ({
    startSession: startSession as any,
    commandPreview: "mock-adapter",
  })
}

function baseDeps(overrides: Partial<SpawnAgentSessionDeps> = {}): {
  registry: ReturnType<typeof createSessionsRegistry>
  deps: SpawnAgentSessionDeps
} {
  const registry = createSessionsRegistry({ persist: false })
  const startSession = vi.fn(async () => fakeAgentSession())
  const deps: SpawnAgentSessionDeps = {
    registry,
    resolveAgentAdapter: makeResolver(startSession),
    resolveAgentsMd: async () => ({ mode: "absent", contractLine: cdContractLine }),
    resolveWorkspaceRules: async () => ({}),
    ...overrides,
  }
  return { registry, deps }
}

function spyProvisioner(
  outcome: WorktreeProvisionOutcome,
): { provisionWorktree: WorktreeProvisioner; calls: Parameters<WorktreeProvisioner>[0][] } {
  const calls: Parameters<WorktreeProvisioner>[0][] = []
  const provisionWorktree: WorktreeProvisioner = vi.fn(async (req) => {
    calls.push(req)
    return outcome
  })
  return { provisionWorktree, calls }
}

const pinMode =
  (mode: WorktreeIsolationMode): (() => Promise<WorktreeIsolationMode>) =>
  async () =>
    mode

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (err: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function claimsOf(events: ObservedAdmission[]): ObservedAdmission[] {
  return events.filter(event => event.stage === "claim")
}

describe("spawnAgentSession — spawn admission parity", () => {
  it("(1) a fresh spawn reports claim allow only when a key exists and returns the same result", async () => {
    const events: ObservedAdmission[] = []
    const { registry, deps } = baseDeps({
      onSpawnAdmission: event => {
        events.push(event as ObservedAdmission)
      },
    })

    const keyed = await spawnAgentSession(deps, {
      adapter: "mock",
      cwd: "/tmp",
      idempotencyKey: "fresh-key",
    })
    expect(keyed.ok).toBe(true)
    if (!keyed.ok) throw new Error("expected success")
    expect(keyed.deduped).toBeUndefined()
    expect(registry.list()).toHaveLength(1)
    expect(claimsOf(events)).toEqual([
      { stage: "claim", decision: { outcome: "allow" } },
    ])

    events.length = 0
    const unkeyed = await spawnAgentSession(deps, {
      adapter: "mock",
      cwd: "/tmp",
      dedupe: false,
    })
    expect(unkeyed.ok).toBe(true)
    if (!unkeyed.ok) throw new Error("expected success")
    expect(unkeyed.deduped).toBeUndefined()
    expect(claimsOf(events)).toEqual([])
    expect(registry.list()).toHaveLength(2)
  })

  it("(2) an explicit idempotencyKey retry reuses the first session and reports the reuse", async () => {
    const events: ObservedAdmission[] = []
    const { deps } = baseDeps({
      onSpawnAdmission: event => {
        events.push(event as ObservedAdmission)
      },
    })
    const input = {
      adapter: "mock",
      cwd: "/tmp",
      label: "worker",
      prompt: "do the thing",
      idempotencyKey: "explicit-retry",
    }

    const first = await spawnAgentSession(deps, input)
    const second = await spawnAgentSession(deps, input)
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    if (!first.ok || !second.ok) throw new Error("expected success")
    expect(second.descriptor.id).toBe(first.descriptor.id)
    expect(second.deduped).toBe(true)
    expect(second.dedupeSource).toBe("explicit")

    const reuse = claimsOf(events).find(event => event.decision.outcome === "reuse")
    expect(reuse).toEqual({
      stage: "claim",
      decision: {
        outcome: "reuse",
        targetId: first.descriptor.id,
        code: "spawn_claim_hit",
      },
      dedupeSource: "explicit",
      label: "worker",
    })
  })

  it("(3) an implicit label plus prompt retry reuses and reports the implicit source", async () => {
    const events: ObservedAdmission[] = []
    const { deps } = baseDeps({
      resolveSpawnDedupe: async () => "always",
      onSpawnAdmission: event => {
        events.push(event as ObservedAdmission)
      },
    })
    const input = {
      adapter: "mock",
      cwd: "/tmp",
      label: "worker",
      prompt: "do the thing",
    }

    const first = await spawnAgentSession(deps, input)
    const second = await spawnAgentSession(deps, input)
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    if (!first.ok || !second.ok) throw new Error("expected success")
    expect(second.descriptor.id).toBe(first.descriptor.id)
    expect(second.deduped).toBe(true)
    expect(second.dedupeSource).toBe("implicit")

    const reuse = claimsOf(events).find(event => event.decision.outcome === "reuse")
    expect(reuse).toEqual({
      stage: "claim",
      decision: {
        outcome: "reuse",
        targetId: first.descriptor.id,
        code: "spawn_claim_hit",
      },
      dedupeSource: "implicit",
      label: "worker",
    })
  })

  it("(4) a retry that hits a failed in-flight claim returns the failure and reports deny with its code", async () => {
    const events: ObservedAdmission[] = []
    const boot = deferred<AgentSessionLike>()
    const startSession = vi.fn(() => boot.promise)
    const { deps } = baseDeps({
      resolveAgentAdapter: makeResolver(startSession),
      onSpawnAdmission: event => {
        events.push(event as ObservedAdmission)
      },
    })
    const input = { adapter: "mock", cwd: "/tmp", idempotencyKey: "failed-retry" }

    const first = spawnAgentSession(deps, input)
    const second = spawnAgentSession(deps, input)
    await vi.waitFor(() => {
      expect(startSession).toHaveBeenCalledTimes(1)
    })
    boot.reject(new Error("adapter boot failed"))

    const [firstResult, secondResult] = await Promise.all([first, second])
    expect(firstResult.ok).toBe(false)
    expect(secondResult.ok).toBe(false)
    if (firstResult.ok || secondResult.ok) throw new Error("expected failure")
    expect(firstResult.code).toBe("agent_spawn_failed")
    expect(secondResult.code).toBe("agent_spawn_failed")

    const deny = claimsOf(events).find(event => event.decision.outcome === "deny")
    expect(deny).toEqual({
      stage: "claim",
      decision: {
        outcome: "deny",
        code: "agent_spawn_failed",
        message: secondResult.message,
      },
    })
  })

  it("(5) a never isolation policy rejects worktree_disabled and reports the policy deny", async () => {
    const events: ObservedAdmission[] = []
    const { registry, deps } = baseDeps({
      resolveWorktreeIsolation: pinMode("never"),
      onSpawnAdmission: event => {
        events.push(event as ObservedAdmission)
      },
    })

    const result = await spawnAgentSession(deps, {
      adapter: "mock",
      cwd: "/repo/checkout",
      worktree: true,
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected failure")
    expect(result.code).toBe("worktree_disabled")
    expect(registry.list()).toHaveLength(0)

    const deny = events.find(event => event.stage === "worktree-policy")
    expect(deny).toEqual({
      stage: "worktree-policy",
      decision: {
        outcome: "deny",
        code: "worktree_disabled",
        message: result.message,
      },
    })
  })

  it("(6) a synchronous worktree collision reuses the first session as worktree-cwd", async () => {
    const events: ObservedAdmission[] = []
    const { registry, deps } = baseDeps({
      onSpawnAdmission: event => {
        events.push(event as ObservedAdmission)
      },
    })
    const { provisionWorktree } = spyProvisioner({
      isolated: true,
      cwd: "/root/repo/agent-abcd1234",
      branch: "wt/agent-abcd1234",
    })
    const shared = { ...deps, provisionWorktree, resolveWorktreeIsolation: pinMode("on-request") }
    const input = {
      adapter: "mock",
      cwd: "/repo/checkout",
      worktree: { slug: "retry", async: false } as const,
      label: "fix login",
    }

    const first = await spawnAgentSession(shared, { ...input, prompt: "do the thing" })
    expect(first.ok).toBe(true)
    if (!first.ok) throw new Error("expected success")
    const second = await spawnAgentSession(shared, {
      ...input,
      prompt: "you are already in an isolated git worktree, continue from there",
    })
    expect(second.ok).toBe(true)
    if (!second.ok) throw new Error("expected success")
    expect(second.descriptor.id).toBe(first.descriptor.id)
    expect(second.deduped).toBe(true)
    expect(second.dedupeSource).toBe("worktree-cwd")
    expect(registry.list()).toHaveLength(1)

    const reuse = events.filter(event => event.stage === "worktree-collision-sync").at(-1)
    expect(reuse).toEqual({
      stage: "worktree-collision-sync",
      decision: {
        outcome: "reuse",
        targetId: first.descriptor.id,
        code: "worktree_label_cwd_collision",
      },
      dedupeSource: "worktree-cwd",
      label: "fix login",
    })
  })

  it("(7) an asynchronous worktree collision settles as an error with the same refusal and reports deny", async () => {
    const events: ObservedAdmission[] = []
    const { registry, deps } = baseDeps({
      onSpawnAdmission: event => {
        events.push(event as ObservedAdmission)
      },
    })
    const worktree = "/root/repo/agent-async1234"
    const { provisionWorktree } = spyProvisioner({
      isolated: true,
      cwd: worktree,
      branch: "wt/agent-async1234",
    })
    const shared = { ...deps, provisionWorktree, resolveWorktreeIsolation: pinMode("on-request") }
    const input = {
      adapter: "mock",
      cwd: "/repo/checkout",
      worktree: { slug: "retry", async: true } as const,
      label: "fix login",
    }

    const first = await spawnAgentSession(shared, { ...input, prompt: "do the thing" })
    expect(first.ok).toBe(true)
    if (!first.ok) throw new Error("expected success")
    await vi.waitFor(() => {
      expect(registry.get(first.descriptor.id)?.status).toBe("running")
    })

    const second = await spawnAgentSession(shared, {
      ...input,
      prompt: "you are already in an isolated git worktree, continue from there",
    })
    expect(second.ok).toBe(true)
    if (!second.ok) throw new Error("expected success")
    expect(second.descriptor.id).not.toBe(first.descriptor.id)

    await vi.waitFor(() => {
      expect(registry.get(second.descriptor.id)?.status).toBe("error")
    })
    const expectedMessage =
      `agent_start: refused — another LIVE session ("${first.descriptor.id}") already has the ` +
      `same label ("fix login") and cwd ("${worktree}") as this worktree spawn. ` +
      "Not starting a second agent in the same worktree."
    expect(registry.get(second.descriptor.id)?.lastError).toBe(expectedMessage)

    const deny = events.filter(event => event.stage === "worktree-collision-async").at(-1)
    expect(deny).toEqual({
      stage: "worktree-collision-async",
      decision: {
        outcome: "deny",
        code: "worktree_label_cwd_collision",
        message: expectedMessage,
      },
      label: "fix login",
    })
  })

  it("(8) a throwing observer never changes the spawn result", async () => {
    const { deps } = baseDeps({
      onSpawnAdmission: () => {
        throw new Error("observer boom")
      },
    })

    const result = await spawnAgentSession(deps, {
      adapter: "mock",
      cwd: "/tmp",
      idempotencyKey: "throwing-observer",
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected success")
    expect(result.deduped).toBeUndefined()
  })
})

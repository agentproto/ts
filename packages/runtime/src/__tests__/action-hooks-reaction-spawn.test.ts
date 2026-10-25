/**
 * Reaction spawn stamping: a spawn made inside a reaction carries the binding
 * origin and the reaction depth, and a spawn outside one is unchanged.
 */

import { describe, expect, it, vi } from "vitest"

import { spawnAgentSession, type SpawnAgentSessionDeps } from "../session-spawn.js"
import {
  createSessionsRegistry,
  type AgentSessionLike,
  type SessionsRegistry,
} from "../sessions.js"
import { cdContractLine } from "../agents-md.js"
import type { AgentAdapterResolver } from "../http-server.js"
import type { WorktreeProvisioner, WorktreeProvisionOutcome } from "../worktree-isolation.js"
import { runInReactionContext, sessionFactsOf } from "../action-hooks/index.js"

function fakeAgentSession(): AgentSessionLike {
  return {
    sessionId: "acp_test",
    // eslint-disable-next-line require-yield
    async *send() {
      return
    },
    async cancel() {},
    async close() {},
  }
}

function makeResolver(startSession: (...args: unknown[]) => Promise<AgentSessionLike>): AgentAdapterResolver {
  return async () => ({
    startSession: startSession as unknown as (opts: unknown) => Promise<AgentSessionLike>,
    commandPreview: "mock-adapter",
  })
}

function baseDeps(): { registry: SessionsRegistry; deps: SpawnAgentSessionDeps } {
  const registry = createSessionsRegistry({ persist: false })
  const startSession = vi.fn(async () => fakeAgentSession())
  const deps: SpawnAgentSessionDeps = {
    registry,
    resolveAgentAdapter: makeResolver(startSession),
    resolveAgentsMd: async () => ({ mode: "absent", contractLine: cdContractLine }),
    resolveWorkspaceRules: async () => ({}),
  }
  return { registry, deps }
}

const ctx = (bindingId: string, reactionDepth: number) => ({
  bindingId,
  reactionDepth,
  causedByEventId: `receipt:${bindingId}`,
})

describe("reaction spawn stamping", () => {
  it("stamps the origin and the reaction meta on a local spawn inside a reaction", async () => {
    const { deps } = baseDeps()
    const result = await runInReactionContext(ctx("bind-a", 2), async () =>
      spawnAgentSession(deps, { adapter: "mock", cwd: "/tmp" }),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected spawn")

    expect(result.descriptor.origin).toBe("reaction:bind-a")
    expect(result.descriptor.meta).toMatchObject({
      reactionDepth: 2,
      causedByEventId: "receipt:bind-a",
    })
  })

  it("leaves a local spawn outside a reaction unchanged", async () => {
    const { deps } = baseDeps()
    const result = await spawnAgentSession(deps, { adapter: "mock", cwd: "/tmp" })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected spawn")

    expect(result.descriptor.origin).toBeUndefined()
    expect(result.descriptor.meta).toBeUndefined()
  })

  it("keeps an explicit origin, keeps existing meta keys and still stamps the depth", async () => {
    const { deps } = baseDeps()
    const result = await runInReactionContext(ctx("bind-a", 2), async () =>
      spawnAgentSession(deps, { adapter: "mock", cwd: "/tmp", origin: "author", boardId: "b-1" }),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected spawn")

    expect(result.descriptor.origin).toBe("author")
    expect(result.descriptor.meta).toMatchObject({
      boardId: "b-1",
      reactionDepth: 2,
      causedByEventId: "receipt:bind-a",
    })
  })

  it("stamps the early descriptor of the async worktree spawn", async () => {
    const { deps } = baseDeps()
    const provisionWorktree: WorktreeProvisioner = vi.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, 5))
      return {
        isolated: true,
        cwd: "/tmp/worktree",
        branch: "wt/test",
      } satisfies WorktreeProvisionOutcome
    })
    const result = await runInReactionContext(ctx("bind-a", 2), async () =>
      spawnAgentSession(
        { ...deps, provisionWorktree, resolveWorktreeIsolation: async () => "on-request" },
        { adapter: "mock", cwd: "/tmp", worktree: { async: true } },
      ),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected spawn")

    expect(result.descriptor.origin).toBe("reaction:bind-a")
    expect(result.descriptor.meta).toMatchObject({
      reactionDepth: 2,
      causedByEventId: "receipt:bind-a",
    })
  })

  it("derives reaction facts from the descriptor meta", async () => {
    const { deps } = baseDeps()
    const result = await runInReactionContext(ctx("bind-a", 2), async () =>
      spawnAgentSession(deps, { adapter: "mock", cwd: "/tmp" }),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected spawn")

    expect(sessionFactsOf(result.descriptor)).toMatchObject({
      origin: "reaction:bind-a",
      reactionDepth: 2,
      causedByEventId: "receipt:bind-a",
    })
  })
})

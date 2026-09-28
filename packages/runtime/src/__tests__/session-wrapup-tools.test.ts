/**
 * `session_wrapup_plan` / `session_wrapup_apply` MCP tools (FIX-9A part 4) —
 * the transport + live-signal gathering around the pure `planSessionWrapup`
 * classifier. This file pins the WIRING (signals reach the planner, results
 * reach the caller, apply re-checks before acting) — the classification
 * rules themselves are covered exhaustively in session-wrapup.test.ts.
 */

import { describe, it, expect } from "vitest"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { createMcpServer } from "@agentproto/mcp-server"

import { registerSessionTools } from "../session-tools.js"
import { createSessionsRegistry } from "../sessions.js"
import type { AgentSessionLike, AgentStreamEvent, SessionsRegistry } from "../sessions.js"
import type { WorktreeStatusLister, WorktreeStatusView } from "../worktree-status.js"

function idleAgentSession(id: string): AgentSessionLike {
  return {
    sessionId: id,
    // eslint-disable-next-line require-yield
    async *send(): AsyncIterable<AgentStreamEvent> {
      await new Promise(() => {}) // never resolves — keeps the session "running"
    },
    async cancel() {},
    async close() {},
  }
}

const OLD_TIMESTAMP = "2000-01-01T00:00:00Z" // guarantees "idle past any threshold"

async function buildHarness(listWorktreeStatuses?: WorktreeStatusLister): Promise<{
  client: Client
  registry: SessionsRegistry
  close: () => Promise<void>
}> {
  const registry = createSessionsRegistry({ persist: false })
  const { server } = await createMcpServer({ specs: [], name: "test", version: "0" })
  registerSessionTools(server, { registry, workspace: process.cwd(), ...(listWorktreeStatuses ? { listWorktreeStatuses } : {}) })

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "test-client", version: "0" })
  await client.connect(clientTransport)

  return { client, registry, close: () => client.close() }
}

function textOf(result: unknown): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (result as any).content[0]?.text ?? "{}"
}

const mergedLister: WorktreeStatusLister = async (_repoRoot, options) => {
  const paths = options?.paths ?? []
  return paths.map(
    (path): WorktreeStatusView => ({
      path,
      branch: "wt/done",
      class: "reclaim",
      reclaimable: true,
      dirty: false,
      base: null,
      pr: { state: "merged", number: 1 },
      sessions: [],
      liveness: { state: "sessions", sessionCount: 1 },
    }),
  )
}

describe("session_wrapup_plan", () => {
  it("classifies an idle, worktree-merged session as close, with an outer envelope of entries+totals", async () => {
    const { client, registry, close } = await buildHarness(mergedLister)
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp/wt/done",
      agentSession: idleAgentSession("acp-1"),
      adapterSlug: "claude-code",
    })
    const rt = registry.get(desc.id)!
    rt.lastActivityAt = OLD_TIMESTAMP
    rt.worktreePath = "/tmp/wt/done"
    rt.mainRepoPath = "/tmp/repo"

    const res = await client.callTool({ name: "session_wrapup_plan", arguments: {} })
    const parsed = JSON.parse(textOf(res)) as { entries: Array<{ sessionId: string; class: string }>; totals: object }
    const entry = parsed.entries.find(e => e.sessionId === desc.id)
    expect(entry).toBeDefined()
    expect(entry?.class).toBe("close")
    expect(parsed.totals).toBeTypeOf("object")

    await close()
    registry.shutdown()
  })

  it("omits keep-class entries by default, includes them with includeKeep:true", async () => {
    const { client, registry, close } = await buildHarness()
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: idleAgentSession("acp-2"),
      adapterSlug: "claude-code",
    })
    const rt = registry.get(desc.id)!
    rt.lastActivityAt = OLD_TIMESTAMP
    rt.busy = true

    const withoutKeep = JSON.parse(
      textOf(await client.callTool({ name: "session_wrapup_plan", arguments: {} })),
    ) as { entries: Array<{ sessionId: string }> }
    expect(withoutKeep.entries.some(e => e.sessionId === desc.id)).toBe(false)

    const withKeep = JSON.parse(
      textOf(await client.callTool({ name: "session_wrapup_plan", arguments: { includeKeep: true } })),
    ) as { entries: Array<{ sessionId: string; class: string }> }
    const entry = withKeep.entries.find(e => e.sessionId === desc.id)
    expect(entry?.class).toBe("keep")

    await close()
    registry.shutdown()
  })

  it("respects a custom idleMinutes threshold", async () => {
    const { client, registry, close } = await buildHarness(mergedLister)
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp/wt/done",
      agentSession: idleAgentSession("acp-3"),
      adapterSlug: "claude-code",
    })
    const rt = registry.get(desc.id)!
    rt.worktreePath = "/tmp/wt/done"
    rt.mainRepoPath = "/tmp/repo"
    // 2 minutes idle — clears no default (20min) threshold, but clears a 1min one.
    rt.lastActivityAt = new Date(Date.now() - 2 * 60_000).toISOString()

    // Below the default 20min threshold ⇒ keep, omitted from the default
    // (includeKeep:false) plan entirely.
    const defaultPlan = JSON.parse(
      textOf(await client.callTool({ name: "session_wrapup_plan", arguments: {} })),
    ) as { entries: Array<{ sessionId: string; class: string }> }
    expect(defaultPlan.entries.find(e => e.sessionId === desc.id)).toBeUndefined()
    const defaultPlanWithKeep = JSON.parse(
      textOf(await client.callTool({ name: "session_wrapup_plan", arguments: { includeKeep: true } })),
    ) as { entries: Array<{ sessionId: string; class: string }> }
    expect(defaultPlanWithKeep.entries.find(e => e.sessionId === desc.id)?.class).toBe("keep")

    const tightPlan = JSON.parse(
      textOf(await client.callTool({ name: "session_wrapup_plan", arguments: { idleMinutes: 1 } })),
    ) as { entries: Array<{ sessionId: string; class: string }> }
    expect(tightPlan.entries.find(e => e.sessionId === desc.id)?.class).toBe("close")

    await close()
    registry.shutdown()
  })
})

describe("session_wrapup_apply", () => {
  it("closes a `close`-class session with verdict:'done' ⇒ steward-completed, resumable", async () => {
    const { client, registry, close } = await buildHarness(mergedLister)
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp/wt/done",
      agentSession: idleAgentSession("acp-4"),
      adapterSlug: "claude-code",
    })
    const rt = registry.get(desc.id)!
    rt.lastActivityAt = OLD_TIMESTAMP
    rt.worktreePath = "/tmp/wt/done"
    rt.mainRepoPath = "/tmp/repo"

    const res = await client.callTool({
      name: "session_wrapup_apply",
      arguments: { sessionIds: [desc.id], verdict: "done" },
    })
    const parsed = JSON.parse(textOf(res)) as {
      results: Array<{ sessionId: string; ok: boolean; class?: string }>
    }
    expect(parsed.results).toEqual([{ sessionId: desc.id, ok: true, class: "close", action: "closed" }])
    expect(registry.get(desc.id)?.endedReason).toBe("steward-completed")
    expect(registry.get(desc.id)?.outcome?.source).toBe("declared")
    expect(registry.get(desc.id)?.outcome?.judgedBy).toBe("steward-rules")

    await close()
    registry.shutdown()
  })

  it("refuses a keep-class session, no exception, session stays running", async () => {
    const { client, registry, close } = await buildHarness()
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: idleAgentSession("acp-5"),
      adapterSlug: "claude-code",
    })
    registry.get(desc.id)!.busy = true

    const res = await client.callTool({
      name: "session_wrapup_apply",
      arguments: { sessionIds: [desc.id], verdict: "done" },
    })
    const parsed = JSON.parse(textOf(res)) as {
      results: Array<{ sessionId: string; ok: boolean; class?: string; error?: string }>
    }
    expect(parsed.results).toEqual([
      { sessionId: desc.id, ok: false, class: "keep", error: "keep_class_never_touched" },
    ])
    expect(registry.get(desc.id)?.status).toBe("running")

    await close()
    registry.shutdown()
  })

  it("refuses an ambiguous `judge`-class session without judgedBy, accepts it with judgedBy", async () => {
    const { client, registry, close } = await buildHarness()
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: idleAgentSession("acp-6"),
      adapterSlug: "claude-code",
    })
    // Idle past the default threshold, but no worktreeMerged/parentEnded
    // signal ⇒ ambiguous "judge" (no lister wired at all in this harness).
    registry.get(desc.id)!.lastActivityAt = OLD_TIMESTAMP

    const refused = await client.callTool({
      name: "session_wrapup_apply",
      arguments: { sessionIds: [desc.id], verdict: "abandoned" },
    })
    const refusedParsed = JSON.parse(textOf(refused)) as {
      results: Array<{ sessionId: string; ok: boolean; class?: string; error?: string }>
    }
    expect(refusedParsed.results).toEqual([
      { sessionId: desc.id, ok: false, class: "judge", error: "ambiguous_needs_judge" },
    ])
    expect(registry.get(desc.id)?.status).toBe("running")

    const judged = await client.callTool({
      name: "session_wrapup_apply",
      arguments: { sessionIds: [desc.id], verdict: "abandoned", judgedBy: "sess_judge1", note: "gave up" },
    })
    const judgedParsed = JSON.parse(textOf(judged)) as {
      results: Array<{ sessionId: string; ok: boolean; class?: string }>
    }
    expect(judgedParsed.results).toEqual([{ sessionId: desc.id, ok: true, class: "judge", action: "closed" }])
    expect(registry.get(desc.id)?.endedReason).toBe("steward-abandoned")
    expect(registry.get(desc.id)?.outcome?.source).toBe("judged")
    expect(registry.get(desc.id)?.outcome?.judgedBy).toBe("sess_judge1")
    expect(registry.get(desc.id)?.outcome?.note).toBe("gave up")

    await close()
    registry.shutdown()
  })

  it("verdict:'blocked'/'needs-input' FLAGS instead of closing — session stays running", async () => {
    const { client, registry, close } = await buildHarness(mergedLister)
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp/wt/done",
      agentSession: idleAgentSession("acp-7"),
      adapterSlug: "claude-code",
    })
    const rt = registry.get(desc.id)!
    rt.lastActivityAt = OLD_TIMESTAMP
    rt.worktreePath = "/tmp/wt/done"
    rt.mainRepoPath = "/tmp/repo"

    const res = await client.callTool({
      name: "session_wrapup_apply",
      arguments: { sessionIds: [desc.id], verdict: "blocked", note: "needs a missing API key" },
    })
    const parsed = JSON.parse(textOf(res)) as {
      results: Array<{ sessionId: string; ok: boolean; class?: string; action?: string }>
    }
    expect(parsed.results).toEqual([{ sessionId: desc.id, ok: true, class: "close", action: "flagged" }])
    expect(registry.get(desc.id)?.status).toBe("running")
    expect(registry.get(desc.id)?.endedReason).toBeUndefined()
    expect(registry.get(desc.id)?.wrapupFlag?.verdict).toBe("blocked")
    expect(registry.get(desc.id)?.wrapupFlag?.note).toBe("needs a missing API key")
    expect(registry.get(desc.id)?.wrapupFlag?.judgedBy).toBe("steward-rules")

    const res2 = await client.callTool({
      name: "session_wrapup_apply",
      arguments: { sessionIds: [desc.id], verdict: "needs-input" },
    })
    const parsed2 = JSON.parse(textOf(res2)) as {
      results: Array<{ sessionId: string; ok: boolean; action?: string }>
    }
    expect(parsed2.results).toEqual([{ sessionId: desc.id, ok: true, class: "close", action: "flagged" }])
    expect(registry.get(desc.id)?.status).toBe("running")
    expect(registry.get(desc.id)?.wrapupFlag?.verdict).toBe("needs-input")

    await close()
    registry.shutdown()
  })

  it("refuses a flag-only verdict too when the session has a pending background task", async () => {
    const { client, registry, close } = await buildHarness(mergedLister)
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp/wt/done",
      agentSession: idleAgentSession("acp-8"),
      adapterSlug: "claude-code",
    })
    const rt = registry.get(desc.id)!
    rt.lastActivityAt = OLD_TIMESTAMP
    rt.worktreePath = "/tmp/wt/done"
    rt.mainRepoPath = "/tmp/repo"
    rt.pendingBgTasks = 1

    // A pending background task also feeds `pendingToolCall` into the
    // planner, so the fresh re-plan sees `judge` here, not `close` — pass
    // judgedBy so the id is still eligible, and confirm closeWithOutcome's
    // OWN pendingBgTasks guard is what refuses it underneath.
    const res = await client.callTool({
      name: "session_wrapup_apply",
      arguments: { sessionIds: [desc.id], verdict: "blocked", judgedBy: "sess_judge1" },
    })
    const parsed = JSON.parse(textOf(res)) as {
      results: Array<{ sessionId: string; ok: boolean; class?: string; error?: string }>
    }
    expect(parsed.results).toEqual([
      { sessionId: desc.id, ok: false, class: "judge", error: "refused_stale_or_busy" },
    ])
    expect(registry.get(desc.id)?.wrapupFlag).toBeUndefined()

    await close()
    registry.shutdown()
  })

  it("reports not_found for an unknown session id", async () => {
    const { client, registry, close } = await buildHarness()
    const res = await client.callTool({
      name: "session_wrapup_apply",
      arguments: { sessionIds: ["nope"], verdict: "done" },
    })
    const parsed = JSON.parse(textOf(res)) as { results: Array<{ sessionId: string; ok: boolean; error?: string }> }
    expect(parsed.results).toEqual([{ sessionId: "nope", ok: false, error: "not_found" }])

    await close()
    registry.shutdown()
  })
})

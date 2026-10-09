/**
 * `session_wrapup_plan` / `session_wrapup_apply` MCP tools (FIX-9A part 4) —
 * the transport + live-signal gathering around the pure `planSessionWrapup`
 * classifier. This file pins the WIRING (signals reach the planner, results
 * reach the caller, apply re-checks before acting) — the classification
 * rules themselves are covered exhaustively in session-wrapup.test.ts.
 */

import { describe, it, expect } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
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

const defaultJobsDir = join(tmpdir(), `swp-jobs-default-${process.pid}`)

async function buildHarness(listWorktreeStatuses?: WorktreeStatusLister, sessionWrapupJobsDir?: string): Promise<{
  client: Client
  registry: SessionsRegistry
  close: () => Promise<void>
}> {
  const registry = createSessionsRegistry({ persist: false })
  const { server } = await createMcpServer({ specs: [], name: "test", version: "0" })
  registerSessionTools(server, {
    registry,
    workspace: process.cwd(),
    sessionWrapupJobsDir: sessionWrapupJobsDir ?? defaultJobsDir,
    sessionWrapupApplyJobsDir: `${sessionWrapupJobsDir ?? defaultJobsDir}-apply`,
    ...(listWorktreeStatuses ? { listWorktreeStatuses } : {}),
  })

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

  it("carries the worktree PR state into the plan signals: open → worktreePrOpen, merged → worktreeMerged", async () => {
    const openLister: WorktreeStatusLister = async (root, options) =>
      (await mergedLister(root, options)).map(v => ({ ...v, pr: { state: "open", number: 505 } }))
    for (const [lister, expected, absent] of [
      [openLister, "worktreePrOpen", "worktreeMerged"],
      [mergedLister, "worktreeMerged", "worktreePrOpen"],
    ] as const) {
      const { client, registry, close } = await buildHarness(lister)
      const desc = registry.spawnAgent({ workspaceSlug: "default", cwd: "/tmp/wt/x", agentSession: idleAgentSession("acp-pr"), adapterSlug: "claude-code" })
      const rt = registry.get(desc.id)!
      rt.lastActivityAt = OLD_TIMESTAMP
      rt.worktreePath = "/tmp/wt/x"
      rt.mainRepoPath = "/tmp/repo"
      const parsed = JSON.parse(textOf(await client.callTool({ name: "session_wrapup_plan", arguments: {} }))) as {
        entries: Array<{ sessionId: string; class: string; signals?: Record<string, unknown> }>
      }
      const entry = parsed.entries.find(e => e.sessionId === desc.id)
      expect(entry?.signals?.[expected]).toBe(true)
      expect(entry?.signals?.[absent]).toBeUndefined()
      await close()
      registry.shutdown()
    }
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

describe("session_wrapup_plan — background mode + per-repo status", () => {
  function spawnMergedIdle(registry: SessionsRegistry, n: number, repo: string): string {
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: `/tmp/wt/${repo}-${n}`,
      agentSession: idleAgentSession(`acp-bg-${repo}-${n}`),
      adapterSlug: "claude-code",
    })
    const rt = registry.get(desc.id)!
    rt.lastActivityAt = OLD_TIMESTAMP
    rt.worktreePath = `/tmp/wt/${repo}-${n}`
    rt.mainRepoPath = `/tmp/${repo}`
    return desc.id
  }

  it("computes worktree status once per repo, not once per session", async () => {
    const calls: Array<{ repoRoot: string; paths: string[] }> = []
    const lister: WorktreeStatusLister = async (repoRoot, options) => {
      calls.push({ repoRoot, paths: [...(options?.paths ?? [])] })
      return mergedLister(repoRoot, options)
    }
    const { client, registry, close } = await buildHarness(lister)
    try {
      for (let n = 0; n < 3; n++) spawnMergedIdle(registry, n, "repo-a")
      spawnMergedIdle(registry, 0, "repo-b")

      const res = await client.callTool({ name: "session_wrapup_plan", arguments: {} })
      const parsed = JSON.parse(textOf(res)) as { entries: Array<{ class: string }> }
      expect(parsed.entries.filter(e => e.class === "close")).toHaveLength(4)
      expect(calls).toHaveLength(2)
      const a = calls.find(c => c.repoRoot === "/tmp/repo-a")!
      expect(a.paths.sort()).toEqual(["/tmp/wt/repo-a-0", "/tmp/wt/repo-a-1", "/tmp/wt/repo-a-2"])
    } finally {
      await close()
      registry.shutdown()
    }
  })

  it("wait:false returns a jobId + followUp; session_wrapup_status goes running → done with the same {entries,totals}", async () => {
    const jobsDir = await mkdtemp(join(tmpdir(), "swp-jobs-"))
    let release!: () => void
    const gate = new Promise<void>(res => {
      release = res
    })
    const slowLister: WorktreeStatusLister = async (repoRoot, options) => {
      await gate
      return mergedLister(repoRoot, options)
    }
    const { client, registry, close } = await buildHarness(slowLister, jobsDir)
    try {
      const id = spawnMergedIdle(registry, 0, "repo-a")
      const started = JSON.parse(
        textOf(await client.callTool({ name: "session_wrapup_plan", arguments: { wait: false } })),
      ) as { jobId: string; status: string; followUp: { tool: string; args: { jobId: string }; pollAfterMs: number } }
      expect(started.status).toBe("running")
      expect(started.jobId).toMatch(/^swp_[0-9a-f]{8}$/)
      expect(started.followUp).toMatchObject({ tool: "session_wrapup_status", args: { jobId: started.jobId }, pollAfterMs: 30000 })

      const running = JSON.parse(
        textOf(await client.callTool({ name: "session_wrapup_status", arguments: { jobId: started.jobId } })),
      ) as { status: string }
      expect(running.status).toBe("running")

      release()
      let done: { status: string; resultPath: string; result: { entries: Array<{ sessionId: string; class: string }> } } | undefined
      for (let i = 0; i < 200; i++) {
        done = JSON.parse(textOf(await client.callTool({ name: "session_wrapup_status", arguments: { jobId: started.jobId } })))
        if (done!.status !== "running") break
        await new Promise(res => setTimeout(res, 10))
      }
      expect(done!.status).toBe("done")
      expect(done!.result.entries.find(e => e.sessionId === id)?.class).toBe("close")
      expect(existsSync(done!.resultPath)).toBe(true)
    } finally {
      release()
      await close()
      registry.shutdown()
      await rm(jobsDir, { recursive: true, force: true })
    }
  })

  it("a plan that outlasts waitMs falls back to the background view", async () => {
    const jobsDir = await mkdtemp(join(tmpdir(), "swp-jobs-"))
    let release!: () => void
    const gate = new Promise<void>(res => {
      release = res
    })
    const { client, registry, close } = await buildHarness(async (repoRoot, options) => {
      await gate
      return mergedLister(repoRoot, options)
    }, jobsDir)
    try {
      spawnMergedIdle(registry, 0, "repo-a")
      const view = JSON.parse(
        textOf(await client.callTool({ name: "session_wrapup_plan", arguments: { waitMs: 20 } })),
      ) as { jobId?: string; status?: string }
      expect(view.status).toBe("running")
      expect(view.jobId).toMatch(/^swp_/)
    } finally {
      release()
      await close()
      registry.shutdown()
      await rm(jobsDir, { recursive: true, force: true })
    }
  })

  it("session_wrapup_status: unknown and malformed ids are errors", async () => {
    const { client, registry, close } = await buildHarness()
    try {
      for (const jobId of ["swp_00000000", "../x"]) {
        const r = await client.callTool({ name: "session_wrapup_status", arguments: { jobId } })
        expect((r as { isError?: boolean }).isError).toBe(true)
        expect(textOf(r)).toContain("not found (no running job and no result file at")
      }
    } finally {
      await close()
      registry.shutdown()
    }
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

describe("session_wrapup_apply — targeted re-plan + background mode", () => {
  function spawnIdleWithWorktree(registry: SessionsRegistry, name: string, repo: string): string {
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: `/tmp/wt/${name}`,
      agentSession: idleAgentSession(`acp-${name}`),
      adapterSlug: "claude-code",
    })
    const rt = registry.get(desc.id)!
    rt.lastActivityAt = OLD_TIMESTAMP
    rt.worktreePath = `/tmp/wt/${name}`
    rt.mainRepoPath = `/tmp/${repo}`
    return desc.id
  }

  it("applying a close-class id computes signals only for that session — one lookup, no other sessions' worktrees", async () => {
    const calls: Array<{ repoRoot: string; paths: string[] }> = []
    const lister: WorktreeStatusLister = async (repoRoot, options) => {
      calls.push({ repoRoot, paths: [...(options?.paths ?? [])] })
      return mergedLister(repoRoot, options)
    }
    const { client, registry, close } = await buildHarness(lister)
    try {
      const target = spawnIdleWithWorktree(registry, "target", "repo-a")
      const other1 = spawnIdleWithWorktree(registry, "other1", "repo-a")
      const other2 = spawnIdleWithWorktree(registry, "other2", "repo-b")

      const res = await client.callTool({
        name: "session_wrapup_apply",
        arguments: { sessionIds: [target], verdict: "done" },
      })
      expect(JSON.parse(textOf(res))).toEqual({
        results: [{ sessionId: target, ok: true, class: "close", action: "closed" }],
      })
      expect(calls).toEqual([{ repoRoot: "/tmp/repo-a", paths: ["/tmp/wt/target"] }])
      expect(registry.get(target)?.endedReason).toBe("steward-completed")
      // Bystanders were neither looked up nor touched.
      expect(registry.get(other1)?.status).toBe("running")
      expect(registry.get(other2)?.status).toBe("running")
    } finally {
      await close()
      registry.shutdown()
    }
  })

  it("still refuses a busy session on the targeted path", async () => {
    const { client, registry, close } = await buildHarness(mergedLister)
    try {
      const id = spawnIdleWithWorktree(registry, "busy", "repo-a")
      registry.get(id)!.busy = true
      const res = await client.callTool({ name: "session_wrapup_apply", arguments: { sessionIds: [id], verdict: "done" } })
      expect(JSON.parse(textOf(res))).toEqual({
        results: [{ sessionId: id, ok: false, class: "keep", error: "keep_class_never_touched" }],
      })
      expect(registry.get(id)?.status).toBe("running")
    } finally {
      await close()
      registry.shutdown()
    }
  })

  it("wait:false returns a swa_ jobId; session_wrapup_status reports the same {results} once done", async () => {
    const jobsDir = await mkdtemp(join(tmpdir(), "swp-jobs-"))
    let release!: () => void
    const gate = new Promise<void>(res => {
      release = res
    })
    const { client, registry, close } = await buildHarness(async (repoRoot, options) => {
      await gate
      return mergedLister(repoRoot, options)
    }, jobsDir)
    try {
      const id = spawnIdleWithWorktree(registry, "bg", "repo-a")
      const started = JSON.parse(
        textOf(await client.callTool({ name: "session_wrapup_apply", arguments: { sessionIds: [id], verdict: "done", wait: false } })),
      ) as { jobId: string; status: string; followUp: { tool: string; args: { jobId: string } } }
      expect(started.status).toBe("running")
      expect(started.jobId).toMatch(/^swa_[0-9a-f]{8}$/)
      expect(started.followUp).toMatchObject({ tool: "session_wrapup_status", args: { jobId: started.jobId } })
      expect(registry.get(id)?.status).toBe("running")

      release()
      let done: { status: string; result: { results: unknown[] } } | undefined
      for (let i = 0; i < 200; i++) {
        done = JSON.parse(textOf(await client.callTool({ name: "session_wrapup_status", arguments: { jobId: started.jobId } })))
        if (done!.status !== "running") break
        await new Promise(res => setTimeout(res, 10))
      }
      expect(done!.status).toBe("done")
      expect(done!.result.results).toEqual([{ sessionId: id, ok: true, class: "close", action: "closed" }])
      expect(registry.get(id)?.endedReason).toBe("steward-completed")
    } finally {
      release()
      await close()
      registry.shutdown()
      await rm(jobsDir, { recursive: true, force: true })
      await rm(`${jobsDir}-apply`, { recursive: true, force: true })
    }
  })

  it("an apply that outlasts waitMs falls back to the background view", async () => {
    const jobsDir = await mkdtemp(join(tmpdir(), "swp-jobs-"))
    let release!: () => void
    const gate = new Promise<void>(res => {
      release = res
    })
    const { client, registry, close } = await buildHarness(async (repoRoot, options) => {
      await gate
      return mergedLister(repoRoot, options)
    }, jobsDir)
    try {
      const id = spawnIdleWithWorktree(registry, "slow", "repo-a")
      const view = JSON.parse(
        textOf(await client.callTool({ name: "session_wrapup_apply", arguments: { sessionIds: [id], verdict: "done", waitMs: 20 } })),
      ) as { jobId?: string; status?: string }
      expect(view.status).toBe("running")
      expect(view.jobId).toMatch(/^swa_/)
    } finally {
      release()
      await close()
      registry.shutdown()
      await rm(jobsDir, { recursive: true, force: true })
      await rm(`${jobsDir}-apply`, { recursive: true, force: true })
    }
  })
})


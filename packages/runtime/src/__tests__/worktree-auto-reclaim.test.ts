/**
 * `SessionDescriptor.worktreeAutoProvisioned` + `createSessionsRegistry`'s
 * `runWorktreeAutoReclaim` port — the exit-time auto-reclaim wiring inside
 * `emitExited` (sessions.ts). The actual classify → re-verify → remove
 * safety logic lives in `@agentproto/worktree`'s `reclaimOneWorktree`
 * (covered by that package's own `gc.test.ts` — reclaim vs. hold, scoped to
 * one worktree, idempotent on an already-gone path); this file is git-free
 * on the RECLAIMER side (a recording stub, mirroring `session-spawn.test.ts`'s
 * `spyProvisioner` — "stays git-free ... asserts WHICH decision was reached,
 * not that git actually forked a tree") and only needs a REAL worktree on
 * disk so `resolveWorktreeIdentity` (a pure filesystem read, no git spawn)
 * actually records `SessionDescriptor.worktreePath` for `emitExited` to key
 * off of.
 */
import { describe, it, expect, afterEach } from "vitest"
import { mkdtemp, rm, writeFile, realpath } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { createSessionsRegistry, type AgentSessionLike } from "../sessions.js"
import type { WorktreeAutoReclaimer } from "../worktree-isolation.js"

function git(cwd: string, ...args: string[]): void {
  const res = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" })
  if (res.status !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr}`)
}

async function makeRepoWithWorktree(branch: string): Promise<{ repo: string; wtPath: string }> {
  const repo = await realpath(await mkdtemp(join(tmpdir(), "wt-auto-reclaim-repo-")))
  git(repo, "init", "-q", "-b", "main")
  git(repo, "config", "user.email", "t@t.t")
  git(repo, "config", "user.name", "t")
  await writeFile(join(repo, "f"), "x")
  git(repo, "add", ".")
  git(repo, "commit", "-q", "-m", "init")
  git(repo, "checkout", "-b", branch)
  git(repo, "checkout", "main")
  const wtPath = join(repo, "..", `${branch.replace(/\//g, "-")}-${Math.random().toString(36).slice(2)}`)
  git(repo, "worktree", "add", wtPath, branch)
  return { repo, wtPath }
}

function fakeAgentSession(): AgentSessionLike {
  return {
    sessionId: "acp_auto_reclaim_test",
    // eslint-disable-next-line require-yield
    async *send(): AsyncIterable<never> {
      return
    },
    async cancel() {},
    async close() {},
  }
}

/** Records every call and lets the test await the settled promise even
 *  though `emitExited` itself fires the port fire-and-forget. */
function recordingReclaimer(impl: (worktreePath: string) => Promise<void> = async () => {}): {
  reclaim: WorktreeAutoReclaimer
  calls: string[]
  settled: () => Promise<void>
} {
  const calls: string[] = []
  let last: Promise<void> = Promise.resolve()
  return {
    reclaim: (worktreePath: string) => {
      calls.push(worktreePath)
      last = impl(worktreePath)
      return last
    },
    calls,
    settled: () => last.catch(() => undefined),
  }
}

const cleanupPaths: string[] = []
afterEach(async () => {
  while (cleanupPaths.length) await rm(cleanupPaths.pop()!, { recursive: true, force: true })
})

describe("exit-time worktree auto-reclaim (SessionDescriptor.worktreeAutoProvisioned)", () => {
  it("a policy-provisioned (implicit) session calls the reclaimer with its own worktree path on kill()", async () => {
    const { repo, wtPath } = await makeRepoWithWorktree("feat/auto-reclaim-implicit")
    cleanupPaths.push(repo)
    cleanupPaths.push(wtPath)

    const { reclaim, calls, settled } = recordingReclaimer()
    const registry = createSessionsRegistry({ persist: false, runWorktreeAutoReclaim: reclaim })
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: wtPath,
      agentSession: fakeAgentSession(),
      adapterSlug: "fake",
      worktreeAutoProvisioned: true,
    })
    // Sanity: the descriptor actually recorded the worktree edge — otherwise
    // this test would pass for the wrong reason (never reaching the gate).
    expect(desc.worktreePath).toBe(wtPath)

    expect(registry.kill(desc.id)).toBe(true)
    expect(calls).toEqual([wtPath])
    await settled()
    registry.shutdown()
  })

  it("an EXPLICITLY requested worktree (no worktreeAutoProvisioned flag) never reaches the reclaimer", async () => {
    const { repo, wtPath } = await makeRepoWithWorktree("feat/auto-reclaim-explicit")
    cleanupPaths.push(repo)
    cleanupPaths.push(wtPath)

    const { reclaim, calls } = recordingReclaimer()
    const registry = createSessionsRegistry({ persist: false, runWorktreeAutoReclaim: reclaim })
    // No `worktreeAutoProvisioned` — mirrors a caller-explicit `worktree:
    // {...}` request (today's manual-cleanup-only behaviour, unchanged).
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: wtPath,
      agentSession: fakeAgentSession(),
      adapterSlug: "fake",
    })
    expect(desc.worktreePath).toBe(wtPath)

    registry.kill(desc.id)
    await Promise.resolve()
    await Promise.resolve()
    expect(calls).toEqual([])
    registry.shutdown()
  })

  it("a session with no worktree at all (cwd outside any repo) never reaches the reclaimer, even if flagged", async () => {
    const plainDir = await realpath(await mkdtemp(join(tmpdir(), "wt-auto-reclaim-plain-")))
    cleanupPaths.push(plainDir)

    const { reclaim, calls } = recordingReclaimer()
    const registry = createSessionsRegistry({ persist: false, runWorktreeAutoReclaim: reclaim })
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: plainDir,
      agentSession: fakeAgentSession(),
      adapterSlug: "fake",
      worktreeAutoProvisioned: true,
    })
    expect(desc.worktreePath).toBeUndefined()

    registry.kill(desc.id)
    await Promise.resolve()
    await Promise.resolve()
    expect(calls).toEqual([])
    registry.shutdown()
  })

  it("a rejecting reclaimer never breaks kill() / session teardown — best-effort only", async () => {
    const { repo, wtPath } = await makeRepoWithWorktree("feat/auto-reclaim-rejects")
    cleanupPaths.push(repo)
    cleanupPaths.push(wtPath)

    const { reclaim, settled } = recordingReclaimer(async () => {
      throw new Error("simulated reclaim failure")
    })
    const registry = createSessionsRegistry({ persist: false, runWorktreeAutoReclaim: reclaim })
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: wtPath,
      agentSession: fakeAgentSession(),
      adapterSlug: "fake",
      worktreeAutoProvisioned: true,
    })

    expect(() => registry.kill(desc.id)).not.toThrow()
    expect(registry.get(desc.id)?.status).toBe("killed")
    await settled()
    registry.shutdown()
  })

  it("emitExited only ever attempts reclaim once, even if it fires more than once for the same session", async () => {
    const { repo, wtPath } = await makeRepoWithWorktree("feat/auto-reclaim-once")
    cleanupPaths.push(repo)
    cleanupPaths.push(wtPath)

    const { reclaim, calls, settled } = recordingReclaimer()
    const registry = createSessionsRegistry({ persist: false, runWorktreeAutoReclaim: reclaim })
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: wtPath,
      agentSession: fakeAgentSession(),
      adapterSlug: "fake",
      worktreeAutoProvisioned: true,
    })

    registry.kill(desc.id)
    // kill() on an already-terminal session is a no-op (returns false) and
    // must not re-attempt reclaim.
    expect(registry.kill(desc.id)).toBe(false)
    await settled()
    expect(calls).toEqual([wtPath])
    registry.shutdown()
  })
})

/**
 * `runSandboxCheckpointGc` port — the exit-time checkpoint-gc wiring inside
 * `emitExited` (sessions.ts). The classify → delete safety logic lives in
 * `@agentproto/worktree`'s `reclaimOneSandboxCheckpoint` (covered by that
 * package's own `checkpoint-gc.test.ts` against a real local git repo); this
 * file is git-free on the reclaimer side (a recording stub, mirroring
 * `worktree-auto-reclaim.test.ts`) and only needs a real git repo on disk so
 * `resolveWorktreeIdentity` records the cwd without exploding — the gate it
 * exercises is a `SandboxDeliveryTarget` on the descriptor.
 */
import { describe, it, expect, afterEach } from "vitest"
import { mkdtemp, rm, writeFile, realpath } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { createSessionsRegistry, type AgentSessionLike } from "../sessions.js"
import type { SandboxCheckpointReclaimer } from "../worktree-isolation.js"

function git(cwd: string, ...args: string[]): void {
  const res = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" })
  if (res.status !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr}`)
}

async function makeRepo(): Promise<string> {
  const repo = await realpath(await mkdtemp(join(tmpdir(), "sandbox-ckpt-gc-repo-")))
  git(repo, "init", "-q", "-b", "main")
  git(repo, "config", "user.email", "t@t.t")
  git(repo, "config", "user.name", "t")
  await writeFile(join(repo, "f"), "x")
  git(repo, "add", ".")
  git(repo, "commit", "-q", "-m", "init")
  return repo
}

function fakeAgentSession(): AgentSessionLike {
  return {
    sessionId: "acp_ckpt_gc_test",
    // eslint-disable-next-line require-yield
    async *send(): AsyncIterable<never> {
      return
    },
    async cancel() {},
    async close() {},
  }
}

interface GcCall {
  cwd?: string
  branch: string
}

/** Records every call and lets the test await the settled promise even
 *  though `emitExited` itself fires the port fire-and-forget. */
function recordingReclaimer(impl: (input: { cwd?: string; branch: string }) => Promise<void> = async () => {}): {
  reclaim: SandboxCheckpointReclaimer
  calls: GcCall[]
  settled: () => Promise<void>
} {
  const calls: GcCall[] = []
  let last: Promise<void> = Promise.resolve()
  return {
    reclaim: (input: { cwd?: string; branch: string }) => {
      calls.push(input)
      last = impl(input)
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

describe("exit-time sandbox checkpoint gc (runSandboxCheckpointGc)", () => {
  it("a sandboxed session with a work branch calls the reclaimer with its own branch and cwd on kill()", async () => {
    const repo = await makeRepo()
    cleanupPaths.push(repo)

    const { reclaim, calls, settled } = recordingReclaimer()
    const registry = createSessionsRegistry({ persist: false, runSandboxCheckpointGc: reclaim })
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: repo,
      agentSession: fakeAgentSession(),
      adapterSlug: "fake",
      sandboxDeliveryTarget: {
        checkoutDir: "/box/home/workspace",
        branch: "wt/feat-1",
        baseSha: "0".repeat(40),
      },
    })
    expect(desc.sandboxDeliveryTarget?.branch).toBe("wt/feat-1")

    expect(registry.kill(desc.id)).toBe(true)
    await settled()
    expect(calls).toEqual([{ cwd: repo, branch: "wt/feat-1" }])
    registry.shutdown()
  })

  it("uses the HOST repo root when the session cwd is a path inside the box", async () => {
    const repo = await makeRepo()
    cleanupPaths.push(repo)

    const { reclaim, calls, settled } = recordingReclaimer()
    const registry = createSessionsRegistry({ persist: false, runSandboxCheckpointGc: reclaim })
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      // The real sandbox descriptor carries the BOX path here.
      cwd: "/home/user/agentproto",
      agentSession: fakeAgentSession(),
      adapterSlug: "fake",
      sandboxRepoRoot: repo,
      sandboxDeliveryTarget: {
        checkoutDir: "/home/user/agentproto",
        branch: "wt/feat-box",
        baseSha: "0".repeat(40),
      },
    })

    expect(registry.kill(desc.id)).toBe(true)
    await settled()
    expect(calls).toEqual([{ cwd: repo, branch: "wt/feat-box" }])
    registry.shutdown()
  })

  it("a session without a sandbox delivery target never reaches the reclaimer", async () => {
    const repo = await makeRepo()
    cleanupPaths.push(repo)

    const { reclaim, calls } = recordingReclaimer()
    const registry = createSessionsRegistry({ persist: false, runSandboxCheckpointGc: reclaim })
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: repo,
      agentSession: fakeAgentSession(),
      adapterSlug: "fake",
    })

    registry.kill(desc.id)
    await Promise.resolve()
    await Promise.resolve()
    expect(calls).toEqual([])
    registry.shutdown()
  })

  it("a rejecting reclaimer never breaks kill() — best-effort only, teardown proceeds", async () => {
    const repo = await makeRepo()
    cleanupPaths.push(repo)

    const { reclaim, settled } = recordingReclaimer(async () => {
      throw new Error("simulated checkpoint gc failure")
    })
    const registry = createSessionsRegistry({ persist: false, runSandboxCheckpointGc: reclaim })
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: repo,
      agentSession: fakeAgentSession(),
      adapterSlug: "fake",
      sandboxDeliveryTarget: {
        checkoutDir: "/box/home/workspace",
        branch: "wt/feat-2",
        baseSha: "0".repeat(40),
      },
    })

    expect(() => registry.kill(desc.id)).not.toThrow()
    expect(registry.get(desc.id)?.status).toBe("killed")
    await settled()
    registry.shutdown()
  })
})

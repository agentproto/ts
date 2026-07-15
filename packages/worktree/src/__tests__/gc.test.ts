/**
 * `gc` (PLAN.md §5, PR-D) safety tests. Mocked-git tests prove nothing about
 * the thing that matters here — every test below drives a real disposable
 * git repo + real `git worktree add`/`remove` (the same posture as
 * `status.test.ts` and `worktree-tools.test.ts`). The one exception is the
 * forge, which is always a test double (`FakeForgeClient` /
 * `UnreachableForgeClient`) — exactly like `status.test.ts` — since the
 * reconciliation rule's own contract is to depend on `ForgeClient` as an
 * interface, never a live network call.
 *
 * `node:child_process`'s `spawn` is wrapped (not mocked away — the real
 * implementation still runs) so the reclaim-argv test can assert on the
 * literal argv git received, the strongest possible check that `--force`
 * never rides along on a reclaim removal.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { mkdtemp, rm, writeFile, mkdir, realpath, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const spawnSpy = vi.fn()
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>()
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      spawnSpy(...args)
      return actual.spawn(...args)
    },
  }
})

import { execGit } from "../exec.js"
import { planGc, applyGc, classifyForGc, type GcApplyOutcome } from "../gc.js"
import { InMemoryVerdictMemoStore, type IntegrationState } from "../status.js"
import { UnreachableForgeClient, type ForgeClient, type ForgePullRequestRef } from "../forge.js"

// ── fixtures (same shape as status.test.ts) ─────────────────────────────

async function makeRepo(): Promise<string> {
  const repo = await realpath(await mkdtemp(join(tmpdir(), "wt-gc-")))
  await execGit(repo, ["init", "-b", "main"])
  await execGit(repo, ["config", "user.email", "t@e.com"])
  await execGit(repo, ["config", "user.name", "T"])
  await writeFile(join(repo, "README.md"), "hello\n")
  await execGit(repo, ["add", "README.md"])
  await execGit(repo, ["commit", "-m", "init"])
  return repo
}

async function headSha(repoRoot: string, ref = "HEAD"): Promise<string> {
  const res = await execGit(repoRoot, ["rev-parse", ref])
  return res.stdout.trim()
}

async function addWorktree(repoRoot: string, path: string, opts: readonly string[], commitish: string): Promise<void> {
  await execGit(repoRoot, ["worktree", "add", ...opts, path, commitish])
}

class FakeForgeClient implements ForgeClient {
  constructor(
    private readonly byBranch: ForgePullRequestRef[] = [],
    private readonly byCommit: ForgePullRequestRef[] = [],
  ) {}
  async pullRequestsForBranch(): Promise<ForgePullRequestRef[]> {
    return this.byBranch
  }
  async pullRequestsForCommit(): Promise<ForgePullRequestRef[]> {
    return this.byCommit
  }
  async ensurePullHeadFetched(): Promise<void> {}
}

function pr(overrides: Partial<ForgePullRequestRef> & { number: number; headRefOid: string }): ForgePullRequestRef {
  return {
    state: "closed",
    merged: true,
    mergedAt: "2026-01-01T00:00:00.000Z",
    headRefName: "irrelevant",
    ...overrides,
  }
}

const FROZEN_NOW = () => "2026-07-15T00:00:00.000Z"

/** Every `git worktree remove` invocation actually captured by the spawn wrapper. */
function worktreeRemoveCalls(): unknown[][] {
  return spawnSpy.mock.calls.filter(
    (call) => call[0] === "git" && Array.isArray(call[1]) && call[1].includes("worktree") && call[1].includes("remove"),
  )
}

beforeEach(() => spawnSpy.mockClear())

const cleanupPaths: string[] = []
afterEach(async () => {
  while (cleanupPaths.length) await rm(cleanupPaths.pop()!, { recursive: true, force: true })
})

// ── classifyForGc unit tests (PLAN.md §5.1) ─────────────────────────────

describe("classifyForGc", () => {
  const CLEAN = { state: "clean" as const }
  const DIRTY = { state: "dirty" as const, modified: 1, staged: 0, untracked: 0 }
  const IDLE = { state: "idle" as const, sessions: [] as never[], services: [] as never[] }
  const DETACHED: IntegrationState = { state: "detached", checkedAt: "t" }
  const MERGED_ANCESTRY: IntegrationState = { state: "merged", via: "ancestry", checkedAt: "t" }

  it("delegates to classify() when --include-detached is absent: clean+idle detached is hold", () => {
    expect(classifyForGc(CLEAN, DETACHED, IDLE)).toBe("hold")
  })

  it("--include-detached moves a clean+idle detached worktree from hold to reclaim", () => {
    expect(classifyForGc(CLEAN, DETACHED, IDLE, { includeDetached: true })).toBe("reclaim")
  })

  it("--include-detached does NOT reclaim a dirty detached worktree", () => {
    expect(classifyForGc(DIRTY, DETACHED, IDLE, { includeDetached: true })).toBe("hold")
  })

  it("--include-detached has no effect on non-detached classes", () => {
    expect(classifyForGc(CLEAN, MERGED_ANCESTRY, IDLE, { includeDetached: true })).toBe("reclaim")
  })
})

// ── the 84f4c06 regression (PLAN.md §0.2) ───────────────────────────────

describe("gc — the 84f4c06 regression: an unmerged commit ahead of a merged PR must never be reclaimed", () => {
  it("classifies hold, and --apply (with or without --salvage-dirty) refuses to touch it", async () => {
    const repo = await makeRepo()
    cleanupPaths.push(repo)
    await execGit(repo, ["checkout", "-b", "docs-check-on-release"])
    await writeFile(join(repo, "a.txt"), "a\n")
    await execGit(repo, ["add", "a.txt"])
    await execGit(repo, ["commit", "-m", "commit that shipped in PR #271"])
    const mergedHead = await headSha(repo) // H — what the forge actually merged
    await writeFile(join(repo, "b.txt"), "b\n")
    await execGit(repo, ["add", "b.txt"])
    await execGit(repo, ["commit", "-m", "fix(release): confine docs-check reads to repo root"])
    const localTip = await headSha(repo) // T — the 84f4c06 stand-in, one commit ahead of the merge
    await execGit(repo, ["checkout", "main"])
    await writeFile(join(repo, "unrelated.txt"), "u\n")
    await execGit(repo, ["add", "unrelated.txt"])
    await execGit(repo, ["commit", "-m", "main moved on"])

    const wtPath = join(repo, "..", `docs-check-${Math.random().toString(36).slice(2)}`)
    cleanupPaths.push(wtPath)
    await addWorktree(repo, wtPath, [], "docs-check-on-release")

    const forge = new FakeForgeClient([pr({ number: 271, headRefOid: mergedHead, headRefName: "docs-check-on-release" })])
    const memo = new InMemoryVerdictMemoStore()

    const plan = await planGc({
      repoRoot: repo,
      repoName: "test-repo",
      forge,
      memo,
      defaultBranchRef: "main",
      now: FROZEN_NOW,
    })
    const entry = plan.find((e) => e.path === wtPath)
    expect(entry?.integration).toMatchObject({ state: "partial", pr: 271, aheadBy: 1 })
    expect(entry?.class).toBe("hold")

    for (const salvageDirty of [false, true]) {
      const outcomes = await applyGc(plan, {
        repoRoot: repo,
        repoName: "test-repo",
        forge,
        memo,
        defaultBranchRef: "main",
        salvageDirty,
        now: FROZEN_NOW,
      })
      const outcome = outcomes.find((o) => o.path === wtPath)
      expect(outcome?.result).toBe("held")
    }

    // Never removed: git still knows about it, the branch and its local
    // commit — the one that would have been destroyed — are both intact.
    const wtList = await execGit(repo, ["worktree", "list", "--porcelain"])
    expect(wtList.stdout).toContain(wtPath)
    expect(await headSha(repo, "docs-check-on-release")).toBe(localTip)
    expect(worktreeRemoveCalls()).toHaveLength(0)
  })
})

// ── reclaim: the actual argv git receives ───────────────────────────────

describe("gc reclaim — the argv passed to git", () => {
  it("never contains --force when removing a reclaim-class worktree", async () => {
    const repo = await makeRepo()
    cleanupPaths.push(repo)
    await execGit(repo, ["checkout", "-b", "feat/reclaim-me"])
    await writeFile(join(repo, "a.txt"), "a\n")
    await execGit(repo, ["add", "a.txt"])
    await execGit(repo, ["commit", "-m", "feat commit"])
    await execGit(repo, ["checkout", "main"])
    await execGit(repo, ["merge", "--ff-only", "feat/reclaim-me"])

    const wtPath = join(repo, "..", `reclaim-${Math.random().toString(36).slice(2)}`)
    cleanupPaths.push(wtPath)
    await addWorktree(repo, wtPath, [], "feat/reclaim-me")

    const forge = new UnreachableForgeClient("must not be called — ancestry alone classifies this")
    const memo = new InMemoryVerdictMemoStore()
    const plan = await planGc({ repoRoot: repo, repoName: "test-repo", forge, memo, defaultBranchRef: "main", now: FROZEN_NOW })
    const entry = plan.find((e) => e.path === wtPath)
    expect(entry?.class).toBe("reclaim")

    spawnSpy.mockClear()
    const outcomes = await applyGc(plan, {
      repoRoot: repo,
      repoName: "test-repo",
      forge,
      memo,
      defaultBranchRef: "main",
      now: FROZEN_NOW,
    })
    const outcome = outcomes.find((o) => o.path === wtPath)
    expect(outcome?.result).toBe("reclaimed")

    const removeCalls = worktreeRemoveCalls()
    expect(removeCalls.length).toBeGreaterThan(0)
    for (const call of removeCalls) expect(call[1]).not.toContain("--force")

    // Branch deletion only ever runs for merged(*) — this entry is exactly that.
    const branches = await execGit(repo, ["branch", "--list", "feat/reclaim-me"])
    expect(branches.stdout.trim()).toBe("")
  })

  it("a merged worktree with only gitignored files (node_modules) is still reclaim-class and removes without --force", async () => {
    const repo = await makeRepo()
    cleanupPaths.push(repo)
    await writeFile(join(repo, ".gitignore"), "node_modules\n")
    await execGit(repo, ["add", ".gitignore"])
    await execGit(repo, ["commit", "-m", "gitignore"])
    await execGit(repo, ["checkout", "-b", "feat/gitignored"])
    await writeFile(join(repo, "a.txt"), "a\n")
    await execGit(repo, ["add", "a.txt"])
    await execGit(repo, ["commit", "-m", "feat commit"])
    await execGit(repo, ["checkout", "main"])
    await execGit(repo, ["merge", "--ff-only", "feat/gitignored"])

    const wtPath = join(repo, "..", `gitignored-${Math.random().toString(36).slice(2)}`)
    cleanupPaths.push(wtPath)
    await addWorktree(repo, wtPath, [], "feat/gitignored")
    await mkdir(join(wtPath, "node_modules"), { recursive: true })
    await writeFile(join(wtPath, "node_modules", "dep.js"), "module.exports = 1\n")

    const forge = new UnreachableForgeClient("must not be called")
    const memo = new InMemoryVerdictMemoStore()
    const plan = await planGc({ repoRoot: repo, repoName: "test-repo", forge, memo, defaultBranchRef: "main", now: FROZEN_NOW })
    const entry = plan.find((e) => e.path === wtPath)
    expect(entry?.tree).toEqual({ state: "clean" })
    expect(entry?.class).toBe("reclaim")

    spawnSpy.mockClear()
    const outcomes = await applyGc(plan, {
      repoRoot: repo,
      repoName: "test-repo",
      forge,
      memo,
      defaultBranchRef: "main",
      now: FROZEN_NOW,
    })
    const outcome = outcomes.find((o) => o.path === wtPath)
    expect(outcome?.result).toBe("reclaimed")

    for (const call of worktreeRemoveCalls()) expect(call[1]).not.toContain("--force")

    const wtList = await execGit(repo, ["worktree", "list", "--porcelain"])
    expect(wtList.stdout).not.toContain(wtPath)
  })
})

// ── salvage: merged + dirty ──────────────────────────────────────────────

describe("gc salvage — a merged, dirty worktree", () => {
  it("is left completely untouched without --salvage-dirty", async () => {
    const repo = await makeRepo()
    cleanupPaths.push(repo)
    await execGit(repo, ["checkout", "-b", "feat/salvage-me"])
    await writeFile(join(repo, "a.txt"), "a\n")
    await execGit(repo, ["add", "a.txt"])
    await execGit(repo, ["commit", "-m", "feat commit"])
    await execGit(repo, ["checkout", "main"])
    await execGit(repo, ["merge", "--ff-only", "feat/salvage-me"])

    const wtPath = join(repo, "..", `salvage-${Math.random().toString(36).slice(2)}`)
    cleanupPaths.push(wtPath)
    await addWorktree(repo, wtPath, [], "feat/salvage-me")
    await writeFile(join(wtPath, "scratch.txt"), "stray output\n")

    const forge = new UnreachableForgeClient("must not be called")
    const memo = new InMemoryVerdictMemoStore()
    const plan = await planGc({ repoRoot: repo, repoName: "test-repo", forge, memo, defaultBranchRef: "main", now: FROZEN_NOW })
    const entry = plan.find((e) => e.path === wtPath)
    expect(entry?.class).toBe("salvage")

    const outcomes = await applyGc(plan, {
      repoRoot: repo,
      repoName: "test-repo",
      forge,
      memo,
      defaultBranchRef: "main",
      salvageDirty: false,
      now: FROZEN_NOW,
    })
    const outcome = outcomes.find((o) => o.path === wtPath)
    expect(outcome?.result).toBe("skipped-dirty")

    const wtList = await execGit(repo, ["worktree", "list", "--porcelain"])
    expect(wtList.stdout).toContain(wtPath)
    expect(await readFile(join(wtPath, "scratch.txt"), "utf8")).toBe("stray output\n")
    expect(worktreeRemoveCalls()).toHaveLength(0)
  })

  it("with --salvage-dirty: the snapshot is written and durable before the worktree is removed", async () => {
    const repo = await makeRepo()
    cleanupPaths.push(repo)
    await execGit(repo, ["checkout", "-b", "feat/salvage-me-2"])
    await writeFile(join(repo, "a.txt"), "a\n")
    await execGit(repo, ["add", "a.txt"])
    await execGit(repo, ["commit", "-m", "feat commit"])
    await execGit(repo, ["checkout", "main"])
    await execGit(repo, ["merge", "--ff-only", "feat/salvage-me-2"])

    const wtPath = join(repo, "..", `salvage2-${Math.random().toString(36).slice(2)}`)
    cleanupPaths.push(wtPath)
    await addWorktree(repo, wtPath, [], "feat/salvage-me-2")
    await writeFile(join(wtPath, "README.md"), "edited\n") // modified tracked file
    await writeFile(join(wtPath, "scratch.txt"), "stray output\n") // untracked file

    const salvageRoot = await mkdtemp(join(tmpdir(), "wt-gc-salvage-root-"))
    cleanupPaths.push(salvageRoot)

    const forge = new UnreachableForgeClient("must not be called")
    const memo = new InMemoryVerdictMemoStore()
    const plan = await planGc({ repoRoot: repo, repoName: "test-repo", forge, memo, defaultBranchRef: "main", now: FROZEN_NOW })
    const entry = plan.find((e) => e.path === wtPath)
    expect(entry?.class).toBe("salvage")

    const outcomes = await applyGc(plan, {
      repoRoot: repo,
      repoName: "test-repo",
      forge,
      memo,
      defaultBranchRef: "main",
      salvageDirty: true,
      salvageRoot,
      now: FROZEN_NOW,
    })
    const outcome = outcomes.find((o) => o.path === wtPath) as Extract<GcApplyOutcome, { result: "salvaged" }>
    expect(outcome?.result).toBe("salvaged")

    // The snapshot is complete: both the modified-tracked-file patch and the
    // untracked file were captured, per the manifest.
    const manifestRaw = await readFile(join(outcome.salvageDir, "MANIFEST.json"), "utf8")
    const manifest = JSON.parse(manifestRaw)
    expect(manifest.hasPatch).toBe(true)
    expect(manifest.untrackedFiles).toEqual(["scratch.txt"])
    const patch = await readFile(join(outcome.salvageDir, "changes.patch"), "utf8")
    expect(patch).toContain("edited")
    const copiedUntracked = await readFile(join(outcome.salvageDir, "untracked", "scratch.txt"), "utf8")
    expect(copiedUntracked).toBe("stray output\n")

    // Only after the snapshot exists is the worktree actually gone.
    const wtList = await execGit(repo, ["worktree", "list", "--porcelain"])
    expect(wtList.stdout).not.toContain(wtPath)
    const branches = await execGit(repo, ["branch", "--list", "feat/salvage-me-2"])
    expect(branches.stdout.trim()).toBe("")
  })
})

// ── offline forge never licenses a guess ────────────────────────────────

describe("gc — an unreachable forge with no memo hit", () => {
  it("classifies unknown(offline) => hold, and --apply refuses to touch it even with --salvage-dirty", async () => {
    const repo = await makeRepo()
    cleanupPaths.push(repo)
    await execGit(repo, ["checkout", "-b", "feat/offline"])
    await writeFile(join(repo, "a.txt"), "a\n")
    await execGit(repo, ["add", "a.txt"])
    await execGit(repo, ["commit", "-m", "commit"])
    // main never advances past this branch's parent, so ancestry can't
    // resolve it either — the only path left is the (unreachable) forge.
    await execGit(repo, ["checkout", "main"])

    const wtPath = join(repo, "..", `offline-${Math.random().toString(36).slice(2)}`)
    cleanupPaths.push(wtPath)
    await addWorktree(repo, wtPath, [], "feat/offline")

    const forge = new UnreachableForgeClient("simulated network outage")
    const memo = new InMemoryVerdictMemoStore()
    const plan = await planGc({ repoRoot: repo, repoName: "test-repo", forge, memo, defaultBranchRef: "main", now: FROZEN_NOW })
    const entry = plan.find((e) => e.path === wtPath)
    expect(entry?.integration).toEqual({ state: "unknown", reason: "offline", checkedAt: FROZEN_NOW() })
    expect(entry?.class).toBe("hold")

    const outcomes = await applyGc(plan, {
      repoRoot: repo,
      repoName: "test-repo",
      forge,
      memo,
      defaultBranchRef: "main",
      salvageDirty: true,
      now: FROZEN_NOW,
    })
    const outcome = outcomes.find((o) => o.path === wtPath)
    expect(outcome?.result).toBe("held")

    const wtList = await execGit(repo, ["worktree", "list", "--porcelain"])
    expect(wtList.stdout).toContain(wtPath)
    expect(worktreeRemoveCalls()).toHaveLength(0)
  })
})

// ── apply-time re-check (layer 2): a stale plan must not license a stale removal ──

describe("gc apply — re-check immediately before touching anything", () => {
  it("aborts when the worktree's branch flips between plan and apply (the rendezvous-deploy branch-flip, PLAN.md §0.2)", async () => {
    const repo = await makeRepo()
    cleanupPaths.push(repo)
    await execGit(repo, ["checkout", "-b", "feat/reclaim-me"])
    await writeFile(join(repo, "a.txt"), "a\n")
    await execGit(repo, ["add", "a.txt"])
    await execGit(repo, ["commit", "-m", "feat commit"])
    await execGit(repo, ["checkout", "main"])
    await execGit(repo, ["merge", "--ff-only", "feat/reclaim-me"])

    // An unmerged branch the worktree will flip onto mid-session, standing in
    // for a live agent switching branches between the plan and the apply.
    await execGit(repo, ["checkout", "-b", "feat/still-in-flight"])
    await writeFile(join(repo, "wip.txt"), "wip\n")
    await execGit(repo, ["add", "wip.txt"])
    await execGit(repo, ["commit", "-m", "still in flight, unmerged"])
    await execGit(repo, ["checkout", "main"])

    const wtPath = join(repo, "..", `flip-${Math.random().toString(36).slice(2)}`)
    cleanupPaths.push(wtPath)
    await addWorktree(repo, wtPath, [], "feat/reclaim-me")

    const forge = new UnreachableForgeClient("must not be called for the ancestry-merged branch")
    const memo = new InMemoryVerdictMemoStore()
    const plan = await planGc({ repoRoot: repo, repoName: "test-repo", forge, memo, defaultBranchRef: "main", now: FROZEN_NOW })
    const entry = plan.find((e) => e.path === wtPath)
    expect(entry?.class).toBe("reclaim")

    // The plan is now stale: the worktree flips onto the unmerged branch.
    await execGit(wtPath, ["checkout", "feat/still-in-flight"])

    spawnSpy.mockClear()
    const outcomes = await applyGc(plan, {
      repoRoot: repo,
      repoName: "test-repo",
      forge: new UnreachableForgeClient("offline — feat/still-in-flight has no memo entry either"),
      memo,
      defaultBranchRef: "main",
      now: FROZEN_NOW,
    })
    const outcome = outcomes.find((o) => o.path === wtPath) as Extract<GcApplyOutcome, { result: "aborted-reclassified" }>
    expect(outcome?.result).toBe("aborted-reclassified")
    expect(outcome.from).toBe("reclaim")
    expect(outcome.to).toBe("hold")

    // Never touched: still on disk, still known to git, still on the branch
    // it flipped to (nothing reverted it, nothing removed it).
    const wtList = await execGit(repo, ["worktree", "list", "--porcelain"])
    expect(wtList.stdout).toContain(wtPath)
    const currentBranch = await execGit(wtPath, ["rev-parse", "--abbrev-ref", "HEAD"])
    expect(currentBranch.stdout.trim()).toBe("feat/still-in-flight")
    expect(worktreeRemoveCalls()).toHaveLength(0)
  })
})

// ── the main worktree is never part of the plan ─────────────────────────

describe("gc plan — the main worktree is structurally excluded", () => {
  it("never appears in the plan, even though it's trivially merged(ancestry) + clean", async () => {
    const repo = await makeRepo()
    cleanupPaths.push(repo)
    const forge = new UnreachableForgeClient("must not be called")
    const memo = new InMemoryVerdictMemoStore()
    const plan = await planGc({ repoRoot: repo, repoName: "test-repo", forge, memo, defaultBranchRef: "main", now: FROZEN_NOW })
    expect(plan.some((e) => e.path === repo)).toBe(false)
  })
})

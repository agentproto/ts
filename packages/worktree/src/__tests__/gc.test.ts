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
import { mkdtemp, rm, writeFile, mkdir, realpath, readFile, utimes, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"

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
import { planGc, applyGc, classifyForGc, reclaimOneWorktree, type GcApplyOutcome } from "../gc.js"
import { InMemoryVerdictMemoStore, listGitWorktrees, type IntegrationState } from "../status.js"
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
  const DIRTY = { state: "dirty" as const, modified: 1, staged: 0, untracked: 0, newestMtimeMs: null }
  const IDLE = { state: "idle" as const, sessions: [] as never[], services: [] as never[] }
  const DETACHED: IntegrationState = { state: "detached", checkedAt: "t" }
  const MERGED_SQUASH: IntegrationState = { state: "merged", via: "squash", pr: 1, checkedAt: "t", offline: false }
  const FRESH: IntegrationState = { state: "fresh", checkedAt: "t" }

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
    expect(classifyForGc(CLEAN, MERGED_SQUASH, IDLE, { includeDetached: true })).toBe("reclaim")
  })

  it("fresh + dirty is hold regardless of --include-detached — ancestry alone never licenses salvage", () => {
    expect(classifyForGc(DIRTY, FRESH, IDLE, { includeDetached: true })).toBe("hold")
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

// ── the 2026-07-15 incident: a fresh, zero-commit branch must never salvage ──

describe("gc — the 2026-07-15 incident: a fresh worktree with uncommitted work must never be reclaimed or salvaged", () => {
  it("reconstructs the exact shape that got a live worktree destroyed: `worktree new`'s branch (zero commits, tip == main), dirty tree", async () => {
    const repo = await makeRepo()
    cleanupPaths.push(repo)

    // Exactly what `worktree new` (#357) produces: a branch cut straight off
    // main with no commits of its own. `fix/blocked-latch-and-stop`'s tip
    // was `origin/main`'s own current commit (#369) — this is that shape.
    const wtPath = join(repo, "..", `fresh-${Math.random().toString(36).slice(2)}`)
    cleanupPaths.push(wtPath)
    await addWorktree(repo, wtPath, ["-b", "wt/fresh-incident"], "main")

    // The agent's in-flight work-in-progress — never committed.
    await writeFile(join(wtPath, "session-notes.md"), "17.5 KB of uncommitted work\n")

    const forge = new UnreachableForgeClient("must not be called — ancestry alone classifies this, and must never authorize salvage")
    const memo = new InMemoryVerdictMemoStore()
    const plan = await planGc({ repoRoot: repo, repoName: "test-repo", forge, memo, defaultBranchRef: "main", now: FROZEN_NOW })
    const entry = plan.find((e) => e.path === wtPath)
    expect(entry?.integration).toEqual({ state: "fresh", checkedAt: FROZEN_NOW() })
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

    // Never touched, with or without --salvage-dirty: still on disk, still a
    // real worktree, the uncommitted file untouched.
    const wtList = await execGit(repo, ["worktree", "list", "--porcelain"])
    expect(wtList.stdout).toContain(wtPath)
    expect(await readFile(join(wtPath, "session-notes.md"), "utf8")).toBe("17.5 KB of uncommitted work\n")
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
  // A GENUINE merge (forge-confirmed squash, not a local ff-merge): step 1's
  // ancestry check can't tell "real commits, fast-forwarded" from "never had
  // any commits of its own" apart (see `fresh` on `reconcileIntegration`), so
  // it never licenses salvage. Only a forge-confirmed `merged` does. Main
  // advances with an unrelated commit so the local ancestry check (step 1)
  // fails and the (fake) forge lookup actually runs.
  async function makeSquashMergedBranch(repo: string, branch: string): Promise<void> {
    await execGit(repo, ["checkout", "-b", branch])
    await writeFile(join(repo, "a.txt"), "a\n")
    await execGit(repo, ["add", "a.txt"])
    await execGit(repo, ["commit", "-m", "feat commit"])
    await execGit(repo, ["checkout", "main"])
    await writeFile(join(repo, "unrelated.txt"), "u\n")
    await execGit(repo, ["add", "unrelated.txt"])
    await execGit(repo, ["commit", "-m", "squash commit standing in for the PR merge"])
  }

  // Backdated well past `RECENT_WRITE_HOLD_WINDOW_MS` — realistic "leftover
  // scratch from a session that ended a while ago", not "written moments
  // ago", which is the other thing that holds instead of salvaging.
  async function backdate(path: string): Promise<void> {
    const longAgo = new Date(Date.now() - 60 * 60 * 1000)
    await utimes(path, longAgo, longAgo)
  }

  it("is left completely untouched without --salvage-dirty", async () => {
    const repo = await makeRepo()
    cleanupPaths.push(repo)
    await makeSquashMergedBranch(repo, "feat/salvage-me")
    const tip = await headSha(repo, "feat/salvage-me")

    const wtPath = join(repo, "..", `salvage-${Math.random().toString(36).slice(2)}`)
    cleanupPaths.push(wtPath)
    await addWorktree(repo, wtPath, [], "feat/salvage-me")
    await writeFile(join(wtPath, "scratch.txt"), "stray output\n")
    await backdate(join(wtPath, "scratch.txt"))

    const forge = new FakeForgeClient([pr({ number: 501, headRefOid: tip, headRefName: "feat/salvage-me" })])
    const memo = new InMemoryVerdictMemoStore()
    const plan = await planGc({ repoRoot: repo, repoName: "test-repo", forge, memo, defaultBranchRef: "main", now: FROZEN_NOW })
    const entry = plan.find((e) => e.path === wtPath)
    expect(entry?.integration).toMatchObject({ state: "merged", via: "squash" })
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
    await makeSquashMergedBranch(repo, "feat/salvage-me-2")
    const tip = await headSha(repo, "feat/salvage-me-2")

    const wtPath = join(repo, "..", `salvage2-${Math.random().toString(36).slice(2)}`)
    cleanupPaths.push(wtPath)
    await addWorktree(repo, wtPath, [], "feat/salvage-me-2")
    await writeFile(join(wtPath, "README.md"), "edited\n") // modified tracked file
    await writeFile(join(wtPath, "scratch.txt"), "stray output\n") // untracked file
    await backdate(join(wtPath, "README.md"))
    await backdate(join(wtPath, "scratch.txt"))

    const salvageRoot = await mkdtemp(join(tmpdir(), "wt-gc-salvage-root-"))
    cleanupPaths.push(salvageRoot)

    const forge = new FakeForgeClient([pr({ number: 502, headRefOid: tip, headRefName: "feat/salvage-me-2" })])
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

  it("a genuinely merged branch is still held, not salvaged, while its dirty scratch was written moments ago", async () => {
    const repo = await makeRepo()
    cleanupPaths.push(repo)
    await makeSquashMergedBranch(repo, "feat/salvage-me-3")
    const tip = await headSha(repo, "feat/salvage-me-3")

    const wtPath = join(repo, "..", `salvage3-${Math.random().toString(36).slice(2)}`)
    cleanupPaths.push(wtPath)
    await addWorktree(repo, wtPath, [], "feat/salvage-me-3")
    await writeFile(join(wtPath, "scratch.txt"), "still being written\n") // NOT backdated — written just now

    const forge = new FakeForgeClient([pr({ number: 503, headRefOid: tip, headRefName: "feat/salvage-me-3" })])
    const memo = new InMemoryVerdictMemoStore()
    // No `nowMs` override: planGc/applyGc default to the real clock, exactly
    // like production — this proves the guard fires without a test needing
    // to hand-tune "now" to line up with a frozen `checkedAt`.
    const plan = await planGc({ repoRoot: repo, repoName: "test-repo", forge, memo, defaultBranchRef: "main", now: FROZEN_NOW })
    const entry = plan.find((e) => e.path === wtPath)
    expect(entry?.integration).toMatchObject({ state: "merged", via: "squash" })
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

    const forge = new UnreachableForgeClient("must not be called for the fresh (ancestry-proven) branch")
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
  it("never appears in the plan, even though it's trivially fresh + clean", async () => {
    const repo = await makeRepo()
    cleanupPaths.push(repo)
    const forge = new UnreachableForgeClient("must not be called")
    const memo = new InMemoryVerdictMemoStore()
    const plan = await planGc({ repoRoot: repo, repoName: "test-repo", forge, memo, defaultBranchRef: "main", now: FROZEN_NOW })
    expect(plan.some((e) => e.path === repo)).toBe(false)
  })
})

// ── dep-bump reclaim exemption: a clean, unpushed, mechanical dep bump ──────
//
// The 47-worktree gc incident this exists for: a weekly `chore(deps): weekly
// minor/patch bump` re-run by a fresh session every time, never pushed,
// piling up as permanent `hold`s. These tests drive the same real-git-repo
// posture as the rest of this file — a bare `origin`, so branching straight
// off `origin/main` gets git's own automatic upstream tracking (no `push`
// involved), which is exactly the shape `unpushed` + `aheadBy` needs and
// exactly how this repo's own worktrees are provisioned (`worktree add -b
// <branch> <dir> origin/main`, verified against this very worktree's
// `git for-each-ref` upstream).

describe("gc — dep-bump reclaim exemption", () => {
  /** A repo with a real bare `origin` and `origin/main` established locally, so branching off it auto-tracks. */
  async function makeRepoWithOriginMain(): Promise<{ repo: string; origin: string }> {
    const repo = await makeRepo()
    const origin = await realpath(await mkdtemp(join(tmpdir(), "wt-gc-dep-bump-origin-")))
    await execGit(origin, ["init", "--bare", "-b", "main"])
    await execGit(repo, ["remote", "add", "origin", origin])
    await execGit(repo, ["push", "origin", "main"])
    return { repo, origin }
  }

  /** Creates `branch` straight off `origin/main` (auto-tracked, per `branch.autoSetupMerge`) and attaches a worktree to it — no checkout in the main repo, so nothing conflicts. */
  async function addDepBumpWorktree(repo: string, branch: string): Promise<string> {
    await execGit(repo, ["branch", branch, "origin/main"])
    const wtPath = join(repo, "..", `dep-bump-${Math.random().toString(36).slice(2)}`)
    await execGit(repo, ["worktree", "add", wtPath, branch])
    return wtPath
  }

  /** Writes `files` (relative paths) and commits them with `message`, inside the worktree itself. */
  async function commitInWorktree(
    wtPath: string,
    message: string,
    files: Record<string, string>,
  ): Promise<void> {
    for (const [relPath, content] of Object.entries(files)) {
      const abs = join(wtPath, relPath)
      await mkdir(dirname(abs), { recursive: true })
      await writeFile(abs, content)
    }
    await execGit(wtPath, ["add", "."])
    await execGit(wtPath, ["commit", "-m", message])
  }

  async function planFor(repo: string, wtPath: string, forge: ForgeClient) {
    const memo = new InMemoryVerdictMemoStore()
    const plan = await planGc({
      repoRoot: repo,
      repoName: "test-repo",
      forge,
      memo,
      defaultBranchRef: "origin/main",
      now: FROZEN_NOW,
    })
    const entry = plan.find((e) => e.path === wtPath)
    return { plan, entry, memo }
  }

  it("a single chore(deps) commit touching only the lockfile + package.json reclaims", async () => {
    const { repo } = await makeRepoWithOriginMain()
    cleanupPaths.push(repo)
    const wtPath = await addDepBumpWorktree(repo, "wt/dep-bump-clean")
    cleanupPaths.push(wtPath)
    await commitInWorktree(wtPath, "chore(deps): weekly minor/patch bump", {
      "pnpm-lock.yaml": "lockfile v2\n",
      "package.json": '{"name":"root","version":"0.0.2"}\n',
    })

    const forge = new FakeForgeClient()
    const { plan, entry } = await planFor(repo, wtPath, forge)
    expect(entry?.integration).toMatchObject({ state: "unpushed", aheadBy: 1 })
    expect(entry?.tree).toEqual({ state: "clean" })
    expect(entry?.class).toBe("reclaim")
    expect(entry?.reclaimReason).toBe("dep-bump")

    spawnSpy.mockClear()
    const outcomes = await applyGc(plan, {
      repoRoot: repo,
      repoName: "test-repo",
      forge,
      memo: new InMemoryVerdictMemoStore(),
      defaultBranchRef: "origin/main",
      now: FROZEN_NOW,
    })
    const outcome = outcomes.find((o) => o.path === wtPath) as Extract<GcApplyOutcome, { result: "reclaimed" }>
    expect(outcome?.result).toBe("reclaimed")
    expect(outcome?.reclaimReason).toBe("dep-bump")
    for (const call of worktreeRemoveCalls()) expect(call[1]).not.toContain("--force")

    const wtList = await execGit(repo, ["worktree", "list", "--porcelain"])
    expect(wtList.stdout).not.toContain(wtPath)
  })

  it("several chore(deps)/fix(deps) commits with a clean cumulative diff reclaim", async () => {
    const { repo } = await makeRepoWithOriginMain()
    cleanupPaths.push(repo)
    const wtPath = await addDepBumpWorktree(repo, "wt/dep-bump-multi")
    cleanupPaths.push(wtPath)
    await commitInWorktree(wtPath, "chore(deps): weekly minor/patch bump", {
      "pnpm-lock.yaml": "lockfile v2\n",
    })
    await commitInWorktree(wtPath, "fix(deps-dev): bump vitest range", {
      "package.json": '{"name":"root","version":"0.0.2"}\n',
      "pnpm-lock.yaml": "lockfile v3\n",
    })

    const forge = new FakeForgeClient()
    const { entry } = await planFor(repo, wtPath, forge)
    expect(entry?.integration).toMatchObject({ state: "unpushed", aheadBy: 2 })
    expect(entry?.class).toBe("reclaim")
    expect(entry?.reclaimReason).toBe("dep-bump")
  })

  it("THE important one: a chore(deps)-titled commit that ALSO touches a .ts file holds, never reclaims", async () => {
    const { repo } = await makeRepoWithOriginMain()
    cleanupPaths.push(repo)
    const wtPath = await addDepBumpWorktree(repo, "wt/dep-bump-liar")
    cleanupPaths.push(wtPath)
    await commitInWorktree(wtPath, "chore(deps): weekly minor/patch bump", {
      "pnpm-lock.yaml": "lockfile v2\n",
      "package.json": '{"name":"root","version":"0.0.2"}\n',
      "src/sneaky.ts": "export const sneaky = true\n",
    })

    const forge = new FakeForgeClient()
    const { plan, entry } = await planFor(repo, wtPath, forge)
    expect(entry?.integration).toMatchObject({ state: "unpushed", aheadBy: 1 })
    expect(entry?.class).toBe("hold")
    expect(entry?.reclaimReason).toBeUndefined()

    spawnSpy.mockClear()
    const outcomes = await applyGc(plan, {
      repoRoot: repo,
      repoName: "test-repo",
      forge,
      memo: new InMemoryVerdictMemoStore(),
      defaultBranchRef: "origin/main",
      now: FROZEN_NOW,
    })
    const outcome = outcomes.find((o) => o.path === wtPath)
    expect(outcome?.result).toBe("held")
    expect(worktreeRemoveCalls()).toHaveLength(0)

    const wtList = await execGit(repo, ["worktree", "list", "--porcelain"])
    expect(wtList.stdout).toContain(wtPath)
    expect(await readFile(join(wtPath, "src", "sneaky.ts"), "utf8")).toBe("export const sneaky = true\n")
  })

  it("one non-bump commit among several bump commits holds — every commit must clear the bar", async () => {
    const { repo } = await makeRepoWithOriginMain()
    cleanupPaths.push(repo)
    const wtPath = await addDepBumpWorktree(repo, "wt/dep-bump-plus-feature")
    cleanupPaths.push(wtPath)
    await commitInWorktree(wtPath, "chore(deps): weekly minor/patch bump", {
      "pnpm-lock.yaml": "lockfile v2\n",
    })
    await commitInWorktree(wtPath, "feat: sneak a feature in behind the bump", {
      "package.json": '{"name":"root","version":"0.0.2"}\n',
    })

    const forge = new FakeForgeClient()
    const { entry } = await planFor(repo, wtPath, forge)
    expect(entry?.integration).toMatchObject({ state: "unpushed", aheadBy: 2 })
    expect(entry?.class).toBe("hold")
    expect(entry?.reclaimReason).toBeUndefined()
  })

  it("a dirty tree holds even when the sole unpushed commit is a clean dep bump", async () => {
    const { repo } = await makeRepoWithOriginMain()
    cleanupPaths.push(repo)
    const wtPath = await addDepBumpWorktree(repo, "wt/dep-bump-dirty")
    cleanupPaths.push(wtPath)
    await commitInWorktree(wtPath, "chore(deps): weekly minor/patch bump", {
      "pnpm-lock.yaml": "lockfile v2\n",
    })
    await writeFile(join(wtPath, "scratch.txt"), "still poking at it\n")

    const forge = new FakeForgeClient()
    const { entry } = await planFor(repo, wtPath, forge)
    expect(entry?.tree?.state).toBe("dirty")
    expect(entry?.class).toBe("hold")
    expect(entry?.reclaimReason).toBeUndefined()
  })

  it("an open PR holds even when every unpushed commit is a clean dep bump", async () => {
    const { repo } = await makeRepoWithOriginMain()
    cleanupPaths.push(repo)
    const branch = "wt/dep-bump-open-pr"
    const wtPath = await addDepBumpWorktree(repo, branch)
    cleanupPaths.push(wtPath)
    await commitInWorktree(wtPath, "chore(deps): weekly minor/patch bump", {
      "pnpm-lock.yaml": "lockfile v2\n",
    })
    const tip = await headSha(wtPath)

    const forge = new FakeForgeClient([pr({ number: 900, state: "open", merged: false, headRefOid: tip, headRefName: branch })])
    const { entry } = await planFor(repo, wtPath, forge)
    expect(entry?.integration).toMatchObject({ state: "open", pr: 900 })
    expect(entry?.class).toBe("hold")
    expect(entry?.reclaimReason).toBeUndefined()
  })

  it("non-regression: an ordinary unpushed feature commit still holds, exactly as before", async () => {
    const { repo } = await makeRepoWithOriginMain()
    cleanupPaths.push(repo)
    const wtPath = await addDepBumpWorktree(repo, "wt/ordinary-feature")
    cleanupPaths.push(wtPath)
    await commitInWorktree(wtPath, "feat: add the thing", {
      "src/thing.ts": "export const thing = 1\n",
    })

    const forge = new FakeForgeClient()
    const { plan, entry } = await planFor(repo, wtPath, forge)
    expect(entry?.integration).toMatchObject({ state: "unpushed", aheadBy: 1 })
    expect(entry?.class).toBe("hold")
    expect(entry?.reclaimReason).toBeUndefined()

    const outcomes = await applyGc(plan, {
      repoRoot: repo,
      repoName: "test-repo",
      forge,
      memo: new InMemoryVerdictMemoStore(),
      defaultBranchRef: "origin/main",
      now: FROZEN_NOW,
    })
    const outcome = outcomes.find((o) => o.path === wtPath)
    expect(outcome?.result).toBe("held")
  })
})

// ── orphan reclaim: an interrupted `git worktree remove` ───────────────────
//
// A `git worktree remove` that dies mid-delete erases `<repo>/.git/worktrees/
// <name>` but can leave the working directory (or part of it) behind on
// disk. Once that metadata is gone, `git worktree list` — and therefore
// `linkedWorktreesOf`, and therefore every classify/reclaim/salvage path
// above — has no way to ever see the directory again; it accumulates
// forever. This section drives the orphan scan directly, independent of (and
// never interfering with) the classify engine covered above.

describe("gc — orphan reclaim: an interrupted `git worktree remove`", () => {
  /** Simulates a `git worktree remove` that died mid-delete: erases only the
   *  git-side metadata (`<repo>/.git/worktrees/<name>`), leaving the working
   *  directory itself — and whatever files were in it — on disk. */
  async function simulateInterruptedRemove(wtPath: string): Promise<void> {
    const gitFile = await readFile(join(wtPath, ".git"), "utf8")
    const match = gitFile.match(/^gitdir:\s*(.+)$/m)
    if (!match?.[1]) throw new Error(`no gitdir pointer found in ${wtPath}/.git`)
    await rm(match[1].trim(), { recursive: true, force: true })
  }

  it("is invisible to git worktree list — and therefore to plain gc — once orphaned: the defect this section fixes", async () => {
    const repo = await makeRepo()
    cleanupPaths.push(repo)
    const worktreesRoot = await realpath(await mkdtemp(join(tmpdir(), "wt-gc-pool-")))
    cleanupPaths.push(worktreesRoot)

    await execGit(repo, ["checkout", "-b", "wt/orphan-invisible"])
    await execGit(repo, ["checkout", "main"])
    const wtPath = join(worktreesRoot, "orphan-invisible")
    await addWorktree(repo, wtPath, [], "wt/orphan-invisible")
    await writeFile(join(wtPath, "leftover.txt"), "still here\n")

    await simulateInterruptedRemove(wtPath)

    // Invisible to git itself — the exact blind spot `linkedWorktreesOf`
    // (and every existing classify/reclaim path) inherits.
    const linked = await listGitWorktrees(repo)
    expect(linked.some((w) => w.path === wtPath)).toBe(false)

    // Plain gc — no `worktreesRoot` passed — never sees it either, exactly
    // like every caller of `planGc` before this change.
    const forge = new UnreachableForgeClient("must not be called")
    const memo = new InMemoryVerdictMemoStore()
    const plainPlan = await planGc({ repoRoot: repo, repoName: "test-repo", forge, memo, defaultBranchRef: "main", now: FROZEN_NOW })
    expect(plainPlan.some((e) => e.path === wtPath)).toBe(false)

    // Still very much on disk, taking up space — the actual leak.
    expect(await readFile(join(wtPath, "leftover.txt"), "utf8")).toBe("still here\n")
  })

  it("shows up in a dry-run plan, distinctly marked, once worktreesRoot is scanned", async () => {
    const repo = await makeRepo()
    cleanupPaths.push(repo)
    const worktreesRoot = await realpath(await mkdtemp(join(tmpdir(), "wt-gc-pool-")))
    cleanupPaths.push(worktreesRoot)

    await execGit(repo, ["checkout", "-b", "wt/orphan-dry-run"])
    await execGit(repo, ["checkout", "main"])
    const wtPath = join(worktreesRoot, "orphan-dry-run")
    await addWorktree(repo, wtPath, [], "wt/orphan-dry-run")
    await simulateInterruptedRemove(wtPath)

    const forge = new UnreachableForgeClient("must not be called — an orphan never reaches classify")
    const memo = new InMemoryVerdictMemoStore()
    const plan = await planGc({
      repoRoot: repo,
      repoName: "test-repo",
      forge,
      memo,
      defaultBranchRef: "main",
      now: FROZEN_NOW,
      worktreesRoot,
    })
    const entry = plan.find((e) => e.path === wtPath)
    expect(entry?.orphan).toBe(true)
    expect(entry?.class).toBe("reclaim")
    expect(entry?.reclaimReason).toBe("orphan")

    // A dry run mutates nothing.
    expect((await stat(wtPath)).isDirectory()).toBe(true)
  })

  it("is removed on apply: true, and re-removing it afterward (already gone) is a harmless no-op", async () => {
    const repo = await makeRepo()
    cleanupPaths.push(repo)
    const worktreesRoot = await realpath(await mkdtemp(join(tmpdir(), "wt-gc-pool-")))
    cleanupPaths.push(worktreesRoot)

    await execGit(repo, ["checkout", "-b", "wt/orphan-apply"])
    await execGit(repo, ["checkout", "main"])
    const wtPath = join(worktreesRoot, "orphan-apply")
    await addWorktree(repo, wtPath, [], "wt/orphan-apply")
    await simulateInterruptedRemove(wtPath)

    const forge = new UnreachableForgeClient("must not be called")
    const memo = new InMemoryVerdictMemoStore()
    const plan = await planGc({
      repoRoot: repo,
      repoName: "test-repo",
      forge,
      memo,
      defaultBranchRef: "main",
      now: FROZEN_NOW,
      worktreesRoot,
    })
    const entry = plan.find((e) => e.path === wtPath)
    expect(entry?.orphan).toBe(true)

    const applyOptions = { repoRoot: repo, repoName: "test-repo", forge, memo, defaultBranchRef: "main", now: FROZEN_NOW }
    const outcomes = await applyGc(plan, applyOptions)
    const outcome = outcomes.find((o) => o.path === wtPath) as Extract<GcApplyOutcome, { result: "reclaimed" }>
    expect(outcome?.result).toBe("reclaimed")
    expect(outcome?.reclaimReason).toBe("orphan")
    await expect(stat(wtPath)).rejects.toThrow()

    // Idempotent: reclaiming the same (now-vanished) entry again is success, not an error.
    const outcomesAgain = await applyGc(plan, applyOptions)
    const outcomeAgain = outcomesAgain.find((o) => o.path === wtPath) as Extract<GcApplyOutcome, { result: "reclaimed" }>
    expect(outcomeAgain?.result).toBe("reclaimed")
    expect(outcomeAgain?.reclaimReason).toBe("orphan")
  })

  it("never removes a directory whose .git pointer doesn't resolve back to this repo's .git/worktrees/", async () => {
    const repo = await makeRepo()
    cleanupPaths.push(repo)
    const otherRepo = await makeRepo() // a different repo, standing in for "not ours"
    cleanupPaths.push(otherRepo)
    const worktreesRoot = await realpath(await mkdtemp(join(tmpdir(), "wt-gc-pool-")))
    cleanupPaths.push(worktreesRoot)

    // A worktree that genuinely belongs to `otherRepo`, sitting in the same
    // pool directory `repo`'s gc sweep will scan (plausible: bucket dirs
    // share one root, see `resolveWorktreesRoot`).
    await execGit(otherRepo, ["checkout", "-b", "wt/not-mine"])
    await execGit(otherRepo, ["checkout", "main"])
    const notMinePath = join(worktreesRoot, "not-mine")
    await addWorktree(otherRepo, notMinePath, [], "wt/not-mine")
    await simulateInterruptedRemove(notMinePath)

    // A plain directory with no `.git` pointer at all.
    const plainDir = join(worktreesRoot, "not-a-worktree-at-all")
    await mkdir(plainDir, { recursive: true })
    await writeFile(join(plainDir, "hello.txt"), "unrelated\n")

    const forge = new UnreachableForgeClient("must not be called")
    const memo = new InMemoryVerdictMemoStore()
    const plan = await planGc({
      repoRoot: repo,
      repoName: "test-repo",
      forge,
      memo,
      defaultBranchRef: "main",
      now: FROZEN_NOW,
      worktreesRoot,
    })
    expect(plan.some((e) => e.path === notMinePath)).toBe(false)
    expect(plan.some((e) => e.path === plainDir)).toBe(false)

    // Neither was ever a plan entry, so applying can't have touched them —
    // confirmed directly on disk too.
    expect((await stat(notMinePath)).isDirectory()).toBe(true)
    expect((await stat(plainDir)).isDirectory()).toBe(true)
  })

  it("never interferes with a real, still-registered dirty worktree — 9 modified tracked files stay held", async () => {
    const repo = await makeRepo()
    cleanupPaths.push(repo)
    const worktreesRoot = await realpath(await mkdtemp(join(tmpdir(), "wt-gc-pool-")))
    cleanupPaths.push(worktreesRoot)

    await execGit(repo, ["checkout", "-b", "wt/dirty-registered"])
    for (let i = 0; i < 9; i++) {
      await writeFile(join(repo, `f${i}.txt`), `v${i}\n`)
      await execGit(repo, ["add", `f${i}.txt`])
    }
    await execGit(repo, ["commit", "-m", "nine files"])
    await execGit(repo, ["checkout", "main"])

    const wtPath = join(worktreesRoot, "dirty-registered")
    await addWorktree(repo, wtPath, [], "wt/dirty-registered")
    for (let i = 0; i < 9; i++) {
      await writeFile(join(wtPath, `f${i}.txt`), `modified ${i}\n`)
    }

    const forge = new UnreachableForgeClient("offline — no memo entry, unpushed/unmerged branch")
    const memo = new InMemoryVerdictMemoStore()
    const plan = await planGc({
      repoRoot: repo,
      repoName: "test-repo",
      forge,
      memo,
      defaultBranchRef: "main",
      now: FROZEN_NOW,
      worktreesRoot,
    })
    const entry = plan.find((e) => e.path === wtPath)
    expect(entry?.orphan).toBeUndefined()
    expect(entry?.tree?.state).toBe("dirty")
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
    expect(await readFile(join(wtPath, "f0.txt"), "utf8")).toBe("modified 0\n")
  })
})

// ── reclaimOneWorktree: exit-time auto-reclaim of a single worktree ────────
//
// The primitive `sessions.ts` calls (via the injected `WorktreeAutoReclaimer`
// port) when a policy-provisioned (implicit) session reaches a terminal
// state. Scoped to exactly one path — a session's own exit must never sweep
// or touch any OTHER worktree in the pool, even a reclaim-class one.

describe("reclaimOneWorktree — exit-time auto-reclaim, scoped to one worktree", () => {
  it("reclaims a merged, clean, idle worktree — exactly like applyGc's own reclaim path", async () => {
    const repo = await makeRepo()
    cleanupPaths.push(repo)
    await execGit(repo, ["checkout", "-b", "feat/exit-reclaim"])
    await writeFile(join(repo, "a.txt"), "a\n")
    await execGit(repo, ["add", "a.txt"])
    await execGit(repo, ["commit", "-m", "feat commit"])
    await execGit(repo, ["checkout", "main"])
    await execGit(repo, ["merge", "--ff-only", "feat/exit-reclaim"])

    const wtPath = join(repo, "..", `exit-reclaim-${Math.random().toString(36).slice(2)}`)
    cleanupPaths.push(wtPath)
    await addWorktree(repo, wtPath, [], "feat/exit-reclaim")

    const forge = new UnreachableForgeClient("must not be called — ancestry alone classifies this")
    const memo = new InMemoryVerdictMemoStore()
    const outcome = await reclaimOneWorktree(wtPath, {
      repoRoot: repo,
      repoName: "test-repo",
      forge,
      memo,
      defaultBranchRef: "main",
      now: FROZEN_NOW,
    })
    expect(outcome?.result).toBe("reclaimed")

    const wtList = await execGit(repo, ["worktree", "list", "--porcelain"])
    expect(wtList.stdout).not.toContain(wtPath)
  })

  it("leaves a dirty, unmerged worktree exactly as-is (held), never removing it", async () => {
    const repo = await makeRepo()
    cleanupPaths.push(repo)
    await execGit(repo, ["checkout", "-b", "feat/exit-hold"])
    await writeFile(join(repo, "a.txt"), "a\n")
    await execGit(repo, ["add", "a.txt"])
    await execGit(repo, ["commit", "-m", "feat commit"])
    await execGit(repo, ["checkout", "main"])

    const wtPath = join(repo, "..", `exit-hold-${Math.random().toString(36).slice(2)}`)
    cleanupPaths.push(wtPath)
    await addWorktree(repo, wtPath, [], "feat/exit-hold")
    await writeFile(join(wtPath, "scratch.txt"), "still working\n")

    const forge = new UnreachableForgeClient("offline — unpushed/unmerged, no memo entry")
    const memo = new InMemoryVerdictMemoStore()
    const outcome = await reclaimOneWorktree(wtPath, {
      repoRoot: repo,
      repoName: "test-repo",
      forge,
      memo,
      defaultBranchRef: "main",
      now: FROZEN_NOW,
    })
    expect(outcome?.result).toBe("held")

    const wtList = await execGit(repo, ["worktree", "list", "--porcelain"])
    expect(wtList.stdout).toContain(wtPath)
    expect(await readFile(join(wtPath, "scratch.txt"), "utf8")).toBe("still working\n")
  })

  it("never touches a DIFFERENT worktree in the same repo, even when it's also reclaim-class", async () => {
    const repo = await makeRepo()
    cleanupPaths.push(repo)

    await execGit(repo, ["checkout", "-b", "feat/exit-reclaim-target"])
    await writeFile(join(repo, "a.txt"), "a\n")
    await execGit(repo, ["add", "a.txt"])
    await execGit(repo, ["commit", "-m", "target commit"])
    await execGit(repo, ["checkout", "main"])
    await execGit(repo, ["merge", "--ff-only", "feat/exit-reclaim-target"])

    await execGit(repo, ["checkout", "-b", "feat/exit-reclaim-other"])
    await writeFile(join(repo, "b.txt"), "b\n")
    await execGit(repo, ["add", "b.txt"])
    await execGit(repo, ["commit", "-m", "other commit"])
    await execGit(repo, ["checkout", "main"])
    await execGit(repo, ["merge", "--ff-only", "feat/exit-reclaim-other"])

    const targetPath = join(repo, "..", `exit-target-${Math.random().toString(36).slice(2)}`)
    cleanupPaths.push(targetPath)
    await addWorktree(repo, targetPath, [], "feat/exit-reclaim-target")

    const otherPath = join(repo, "..", `exit-other-${Math.random().toString(36).slice(2)}`)
    cleanupPaths.push(otherPath)
    await addWorktree(repo, otherPath, [], "feat/exit-reclaim-other")

    const forge = new UnreachableForgeClient("must not be called")
    const memo = new InMemoryVerdictMemoStore()
    const outcome = await reclaimOneWorktree(targetPath, {
      repoRoot: repo,
      repoName: "test-repo",
      forge,
      memo,
      defaultBranchRef: "main",
      now: FROZEN_NOW,
    })
    expect(outcome?.result).toBe("reclaimed")

    // The OTHER reclaim-class worktree was never touched by this call.
    const wtList = await execGit(repo, ["worktree", "list", "--porcelain"])
    expect(wtList.stdout).not.toContain(targetPath)
    expect(wtList.stdout).toContain(otherPath)
  })

  it("returns null (not an error) when the path no longer names a linked worktree", async () => {
    const repo = await makeRepo()
    cleanupPaths.push(repo)
    const forge = new UnreachableForgeClient("must not be called")
    const memo = new InMemoryVerdictMemoStore()
    const outcome = await reclaimOneWorktree(join(repo, "..", "never-existed"), {
      repoRoot: repo,
      repoName: "test-repo",
      forge,
      memo,
      defaultBranchRef: "main",
      now: FROZEN_NOW,
    })
    expect(outcome).toBeNull()
  })
})

// ── protectedPaths: live-session-cwd protection ─────────────────────────
//
// Regression coverage for the 2026-08-22 incident: a running daemon
// session's own cwd (a worktree the session was actively using) classified
// `reclaim` and would have been deleted out from under it by the next
// `--apply` sweep. `classify`'s own liveness axis is snapshot-based
// (`computeLiveness`, status.ts) and depends on the caller passing a
// sessions snapshot that actually contains the session; `protectedPaths` is
// a second, independent belt-and-suspenders check a caller with a stronger
// source of truth (e.g. the daemon's live in-memory session registry) can
// use to hold a path unconditionally, regardless of what `classify`
// concludes.
describe("gc — protectedPaths: live-session-cwd protection", () => {
  it("without protectedPaths: a merged, clean worktree is plain reclaim (the defect this section fixes)", async () => {
    const repo = await makeRepo()
    cleanupPaths.push(repo)
    await execGit(repo, ["checkout", "-b", "feat/protected-repro"])
    await writeFile(join(repo, "a.txt"), "a\n")
    await execGit(repo, ["add", "a.txt"])
    await execGit(repo, ["commit", "-m", "feat commit"])
    await execGit(repo, ["checkout", "main"])
    await execGit(repo, ["merge", "--ff-only", "feat/protected-repro"])

    const wtPath = join(repo, "..", `protected-repro-${Math.random().toString(36).slice(2)}`)
    cleanupPaths.push(wtPath)
    await addWorktree(repo, wtPath, [], "feat/protected-repro")

    const forge = new UnreachableForgeClient("must not be called — ancestry alone classifies this")
    const memo = new InMemoryVerdictMemoStore()
    const plan = await planGc({ repoRoot: repo, repoName: "test-repo", forge, memo, defaultBranchRef: "main", now: FROZEN_NOW })
    const entry = plan.find((e) => e.path === wtPath)
    expect(entry?.class).toBe("reclaim")
  })

  it("exact-match protectedPaths entry holds a worktree that would otherwise reclaim, and applyGc never removes it", async () => {
    const repo = await makeRepo()
    cleanupPaths.push(repo)
    await execGit(repo, ["checkout", "-b", "feat/protected-exact"])
    await writeFile(join(repo, "a.txt"), "a\n")
    await execGit(repo, ["add", "a.txt"])
    await execGit(repo, ["commit", "-m", "feat commit"])
    await execGit(repo, ["checkout", "main"])
    await execGit(repo, ["merge", "--ff-only", "feat/protected-exact"])

    const wtPath = join(repo, "..", `protected-exact-${Math.random().toString(36).slice(2)}`)
    cleanupPaths.push(wtPath)
    await addWorktree(repo, wtPath, [], "feat/protected-exact")

    const forge = new UnreachableForgeClient("must not be called — protection wins before classification runs")
    const memo = new InMemoryVerdictMemoStore()
    const plan = await planGc({
      repoRoot: repo,
      repoName: "test-repo",
      forge,
      memo,
      defaultBranchRef: "main",
      now: FROZEN_NOW,
      protectedPaths: [wtPath],
    })
    const entry = plan.find((e) => e.path === wtPath)
    expect(entry?.class).toBe("hold")
    expect(entry?.holdReason).toBe("live-session-cwd")

    const outcomes = await applyGc(plan, {
      repoRoot: repo,
      repoName: "test-repo",
      forge,
      memo,
      defaultBranchRef: "main",
      now: FROZEN_NOW,
      protectedPaths: [wtPath],
    })
    const outcome = outcomes.find((o) => o.path === wtPath)
    expect(outcome?.result).toBe("held")

    const wtList = await execGit(repo, ["worktree", "list", "--porcelain"])
    expect(wtList.stdout).toContain(wtPath)
  })

  it("a session cwd that's a SUBDIRECTORY of the worktree also holds it", async () => {
    const repo = await makeRepo()
    cleanupPaths.push(repo)
    await execGit(repo, ["checkout", "-b", "feat/protected-subdir"])
    await writeFile(join(repo, "a.txt"), "a\n")
    await execGit(repo, ["add", "a.txt"])
    await execGit(repo, ["commit", "-m", "feat commit"])
    await execGit(repo, ["checkout", "main"])
    await execGit(repo, ["merge", "--ff-only", "feat/protected-subdir"])

    const wtPath = join(repo, "..", `protected-subdir-${Math.random().toString(36).slice(2)}`)
    cleanupPaths.push(wtPath)
    await addWorktree(repo, wtPath, [], "feat/protected-subdir")
    const sessionCwd = join(wtPath, "packages", "app")

    const forge = new UnreachableForgeClient("must not be called")
    const memo = new InMemoryVerdictMemoStore()
    const plan = await planGc({
      repoRoot: repo,
      repoName: "test-repo",
      forge,
      memo,
      defaultBranchRef: "main",
      now: FROZEN_NOW,
      protectedPaths: [sessionCwd],
    })
    const entry = plan.find((e) => e.path === wtPath)
    expect(entry?.class).toBe("hold")
    expect(entry?.holdReason).toBe("live-session-cwd")
  })

  it("a sibling path that merely shares a string prefix is NOT protected (/a/b vs /a/bc)", async () => {
    const repo = await makeRepo()
    cleanupPaths.push(repo)
    await execGit(repo, ["checkout", "-b", "feat/protected-sibling"])
    await writeFile(join(repo, "a.txt"), "a\n")
    await execGit(repo, ["add", "a.txt"])
    await execGit(repo, ["commit", "-m", "feat commit"])
    await execGit(repo, ["checkout", "main"])
    await execGit(repo, ["merge", "--ff-only", "feat/protected-sibling"])

    const wtPath = join(repo, "..", `protected-sibling-${Math.random().toString(36).slice(2)}`)
    cleanupPaths.push(wtPath)
    await addWorktree(repo, wtPath, [], "feat/protected-sibling")
    // Shares wtPath as a literal string prefix but is a DIFFERENT directory
    // (no path-separator boundary) — must never be treated as "inside" wtPath.
    const unrelatedSibling = `${wtPath}-other`

    const forge = new UnreachableForgeClient("must not be called — ancestry alone classifies this")
    const memo = new InMemoryVerdictMemoStore()
    const plan = await planGc({
      repoRoot: repo,
      repoName: "test-repo",
      forge,
      memo,
      defaultBranchRef: "main",
      now: FROZEN_NOW,
      protectedPaths: [unrelatedSibling],
    })
    const entry = plan.find((e) => e.path === wtPath)
    expect(entry?.class).toBe("reclaim")
  })

  it("protects an orphan entry too, and applyGc leaves it on disk instead of removing it", async () => {
    const repo = await makeRepo()
    cleanupPaths.push(repo)
    const worktreesRoot = await realpath(await mkdtemp(join(tmpdir(), "wt-gc-pool-")))
    cleanupPaths.push(worktreesRoot)

    await execGit(repo, ["checkout", "-b", "wt/orphan-protected"])
    await execGit(repo, ["checkout", "main"])
    const wtPath = join(worktreesRoot, "orphan-protected")
    await addWorktree(repo, wtPath, [], "wt/orphan-protected")
    const gitFile = await readFile(join(wtPath, ".git"), "utf8")
    const match = gitFile.match(/^gitdir:\s*(.+)$/m)
    if (!match?.[1]) throw new Error(`no gitdir pointer found in ${wtPath}/.git`)
    await rm(match[1].trim(), { recursive: true, force: true })

    const forge = new UnreachableForgeClient("must not be called — an orphan never reaches classify")
    const memo = new InMemoryVerdictMemoStore()
    const plan = await planGc({
      repoRoot: repo,
      repoName: "test-repo",
      forge,
      memo,
      defaultBranchRef: "main",
      now: FROZEN_NOW,
      worktreesRoot,
      protectedPaths: [wtPath],
    })
    const entry = plan.find((e) => e.path === wtPath)
    expect(entry?.class).toBe("hold")
    expect(entry?.holdReason).toBe("live-session-cwd")
    expect(entry?.orphan).toBeFalsy()

    const outcomes = await applyGc(plan, {
      repoRoot: repo,
      repoName: "test-repo",
      forge,
      memo,
      defaultBranchRef: "main",
      now: FROZEN_NOW,
      protectedPaths: [wtPath],
    })
    const outcome = outcomes.find((o) => o.path === wtPath)
    expect(outcome?.result).toBe("held")
    expect((await stat(wtPath)).isDirectory()).toBe(true)
  })

  it("TOCTOU: applyGc refuses to remove a protected path even when the PLAN was built without protectedPaths (stale plan)", async () => {
    const repo = await makeRepo()
    cleanupPaths.push(repo)
    await execGit(repo, ["checkout", "-b", "feat/protected-toctou"])
    await writeFile(join(repo, "a.txt"), "a\n")
    await execGit(repo, ["add", "a.txt"])
    await execGit(repo, ["commit", "-m", "feat commit"])
    await execGit(repo, ["checkout", "main"])
    await execGit(repo, ["merge", "--ff-only", "feat/protected-toctou"])

    const wtPath = join(repo, "..", `protected-toctou-${Math.random().toString(36).slice(2)}`)
    cleanupPaths.push(wtPath)
    await addWorktree(repo, wtPath, [], "feat/protected-toctou")

    const forge = new UnreachableForgeClient("must not be called")
    const memo = new InMemoryVerdictMemoStore()
    // Plan built with no knowledge of protection at all — the stale-plan shape.
    const plan = await planGc({ repoRoot: repo, repoName: "test-repo", forge, memo, defaultBranchRef: "main", now: FROZEN_NOW })
    const entry = plan.find((e) => e.path === wtPath)
    expect(entry?.class).toBe("reclaim")

    // By apply time, a session has started using this cwd — passed only here.
    const outcomes = await applyGc(plan, {
      repoRoot: repo,
      repoName: "test-repo",
      forge,
      memo,
      defaultBranchRef: "main",
      now: FROZEN_NOW,
      protectedPaths: [wtPath],
    })
    const outcome = outcomes.find((o) => o.path === wtPath)
    expect(outcome?.result).toBe("aborted-reclassified")
    expect(outcome && "to" in outcome ? outcome.to : undefined).toBe("hold")

    const wtList = await execGit(repo, ["worktree", "list", "--porcelain"])
    expect(wtList.stdout).toContain(wtPath)
  })
})

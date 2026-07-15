import { describe, it, expect, afterEach } from "vitest"
import { mkdtemp, rm, writeFile, mkdir, realpath } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execGit } from "../exec.js"
import {
  computeTreeState,
  reconcileIntegration,
  computeWorktreeStatus,
  listGitWorktrees,
  classify,
  InMemoryVerdictMemoStore,
  FileVerdictMemoStore,
  type IntegrationState,
} from "../status.js"
import { UnreachableForgeClient, ForgeUnavailableError, type ForgeClient, type ForgePullRequestRef } from "../forge.js"

// ── fixtures ─────────────────────────────────────────────────────────────

async function makeRepo(): Promise<string> {
  // `realpath` because `mkdtemp(tmpdir())` on macOS returns a `/var/...` path
  // that's a symlink to `/private/var/...` — `git worktree list --porcelain`
  // reports the resolved path, so tests comparing paths must too.
  const repo = await realpath(await mkdtemp(join(tmpdir(), "wt-status-")))
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

/** `git worktree add [opts] <path> [<commit-ish>]` — opts before path, commit-ish after. */
async function addWorktree(
  repoRoot: string,
  path: string,
  opts: readonly string[],
  commitish?: string,
): Promise<void> {
  await execGit(repoRoot, ["worktree", "add", ...opts, path, ...(commitish ? [commitish] : [])])
}

/** A `ForgeClient` test double with canned responses and an in-repo `ensurePullHeadFetched` no-op. */
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
  async ensurePullHeadFetched(): Promise<void> {
    // Every fixture commit already lives in the same local repo's odb.
  }
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

describe("computeTreeState", () => {
  const cleanupPaths: string[] = []
  afterEach(async () => {
    while (cleanupPaths.length) await rm(cleanupPaths.pop()!, { recursive: true, force: true })
  })

  it("reports clean for a freshly committed tree", async () => {
    const repo = await makeRepo()
    cleanupPaths.push(repo)
    expect(await computeTreeState(repo)).toEqual({ state: "clean" })
  })

  it("counts modified, staged, and untracked separately", async () => {
    const repo = await makeRepo()
    cleanupPaths.push(repo)
    await writeFile(join(repo, "README.md"), "changed\n") // modified, unstaged
    await writeFile(join(repo, "new.txt"), "new\n") // untracked
    await writeFile(join(repo, "staged.txt"), "staged\n")
    await execGit(repo, ["add", "staged.txt"]) // staged
    expect(await computeTreeState(repo)).toEqual({ state: "dirty", modified: 1, staged: 1, untracked: 1 })
  })

  it("never reports gitignored files as dirty", async () => {
    const repo = await makeRepo()
    cleanupPaths.push(repo)
    await writeFile(join(repo, ".gitignore"), "ignored/\n")
    await execGit(repo, ["add", ".gitignore"])
    await execGit(repo, ["commit", "-m", "ignore"])
    await mkdir(join(repo, "ignored"))
    await writeFile(join(repo, "ignored", "scratch.txt"), "x\n")
    expect(await computeTreeState(repo)).toEqual({ state: "clean" })
  })
})

describe("reconcileIntegration (PLAN.md §1.3)", () => {
  const cleanupPaths: string[] = []
  afterEach(async () => {
    while (cleanupPaths.length) await rm(cleanupPaths.pop()!, { recursive: true, force: true })
  })

  it("step 1: merged(ancestry) when the tip is contained in the default branch — never calls the forge", async () => {
    const repo = await makeRepo()
    cleanupPaths.push(repo)
    await execGit(repo, ["checkout", "-b", "feat/ff"])
    await writeFile(join(repo, "a.txt"), "a\n")
    await execGit(repo, ["add", "a.txt"])
    await execGit(repo, ["commit", "-m", "feat commit"])
    const tip = await headSha(repo)
    await execGit(repo, ["checkout", "main"])
    await execGit(repo, ["merge", "--ff-only", "feat/ff"])

    const forge: ForgeClient = new UnreachableForgeClient("must not be called")
    const result = await reconcileIntegration({
      repoRoot: repo,
      repoName: "test-repo",
      branch: "feat/ff",
      tipSha: tip,
      forge,
      memo: new InMemoryVerdictMemoStore(),
      defaultBranchRef: "main",
      now: FROZEN_NOW,
    })
    expect(result).toEqual({ state: "merged", via: "ancestry", checkedAt: FROZEN_NOW() })
  })

  it("step 2: merged(squash) when the forge's merged PR head contains the local tip", async () => {
    const repo = await makeRepo()
    cleanupPaths.push(repo)
    await execGit(repo, ["checkout", "-b", "feat/squash"])
    await writeFile(join(repo, "a.txt"), "a\n")
    await execGit(repo, ["add", "a.txt"])
    await execGit(repo, ["commit", "-m", "commit A"])
    await writeFile(join(repo, "b.txt"), "b\n")
    await execGit(repo, ["add", "b.txt"])
    await execGit(repo, ["commit", "-m", "commit B"])
    const tip = await headSha(repo) // B — exactly what the PR head was
    // main advances independently with an unrelated commit — a real squash
    // merge creates a brand-new commit on main, so ancestry (step 1) must fail.
    await execGit(repo, ["checkout", "main"])
    await writeFile(join(repo, "unrelated.txt"), "u\n")
    await execGit(repo, ["add", "unrelated.txt"])
    await execGit(repo, ["commit", "-m", "squash commit standing in for the PR merge"])

    const forge = new FakeForgeClient([pr({ number: 318, headRefOid: tip, headRefName: "feat/squash" })])
    const result = await reconcileIntegration({
      repoRoot: repo,
      repoName: "test-repo",
      branch: "feat/squash",
      tipSha: tip,
      forge,
      memo: new InMemoryVerdictMemoStore(),
      defaultBranchRef: "main",
      now: FROZEN_NOW,
    })
    expect(result).toEqual({ state: "merged", via: "squash", pr: 318, checkedAt: FROZEN_NOW(), offline: false })
  })

  it("step 2: partial when local commits exist beyond the merged PR head — the docs-check-on-release repro (#271, 84f4c06)", async () => {
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
    const localTip = await headSha(repo) // T — one commit ahead of the merge, e.g. 84f4c06
    await execGit(repo, ["checkout", "main"])
    await writeFile(join(repo, "unrelated.txt"), "u\n")
    await execGit(repo, ["add", "unrelated.txt"])
    await execGit(repo, ["commit", "-m", "main moved on"])

    const forge = new FakeForgeClient([
      pr({ number: 271, headRefOid: mergedHead, headRefName: "docs-check-on-release" }),
    ])
    const result = await reconcileIntegration({
      repoRoot: repo,
      repoName: "test-repo",
      branch: "docs-check-on-release",
      tipSha: localTip,
      forge,
      memo: new InMemoryVerdictMemoStore(),
      defaultBranchRef: "main",
      now: FROZEN_NOW,
    })
    expect(result).toEqual({ state: "partial", pr: 271, aheadBy: 1, checkedAt: FROZEN_NOW(), offline: false })
    // Structurally impossible to reclaim: a "partial" verdict never satisfies `merged`.
    expect(classify({ state: "clean" }, result, { state: "idle", sessions: [], services: [] }).reclaimable).toBe(
      false,
    )
    expect(classify({ state: "clean" }, result, { state: "idle", sessions: [], services: [] }).class).toBe("hold")
  })

  it("step 3: open when no merged PR contains the tip but an open one exists", async () => {
    const repo = await makeRepo()
    cleanupPaths.push(repo)
    await execGit(repo, ["checkout", "-b", "feat/wip"])
    await writeFile(join(repo, "a.txt"), "a\n")
    await execGit(repo, ["add", "a.txt"])
    await execGit(repo, ["commit", "-m", "wip"])
    const tip = await headSha(repo)

    const forge = new FakeForgeClient([
      pr({ number: 42, state: "open", merged: false, mergedAt: null, headRefOid: tip, headRefName: "feat/wip" }),
    ])
    const result = await reconcileIntegration({
      repoRoot: repo,
      repoName: "test-repo",
      branch: "feat/wip",
      tipSha: tip,
      forge,
      memo: new InMemoryVerdictMemoStore(),
      defaultBranchRef: "main",
      now: FROZEN_NOW,
    })
    expect(result).toEqual({ state: "open", pr: 42, checkedAt: FROZEN_NOW(), offline: false })
  })

  it("step 2: diverged when a merged PR is found but contains neither T nor is contained by it", async () => {
    const repo = await makeRepo()
    cleanupPaths.push(repo)
    await execGit(repo, ["checkout", "-b", "feat/branch-a"])
    await writeFile(join(repo, "a.txt"), "a\n")
    await execGit(repo, ["add", "a.txt"])
    await execGit(repo, ["commit", "-m", "on branch a"])
    const tipA = await headSha(repo)

    await execGit(repo, ["checkout", "main"])
    await execGit(repo, ["checkout", "-b", "feat/branch-b"])
    await writeFile(join(repo, "b.txt"), "b\n")
    await execGit(repo, ["add", "b.txt"])
    await execGit(repo, ["commit", "-m", "unrelated merged PR head"])
    const tipB = await headSha(repo)

    const forge = new FakeForgeClient([pr({ number: 99, headRefOid: tipB, headRefName: "feat/branch-b" })])
    const result = await reconcileIntegration({
      repoRoot: repo,
      repoName: "test-repo",
      branch: "feat/branch-a",
      tipSha: tipA,
      forge,
      memo: new InMemoryVerdictMemoStore(),
      defaultBranchRef: "main",
      now: FROZEN_NOW,
    })
    expect(result).toEqual({ state: "diverged", checkedAt: FROZEN_NOW(), offline: false })
  })

  it("step 4: local-only when no PR exists and there is no upstream", async () => {
    const repo = await makeRepo()
    cleanupPaths.push(repo)
    await execGit(repo, ["checkout", "-b", "feat/local"])
    await writeFile(join(repo, "a.txt"), "a\n")
    await execGit(repo, ["add", "a.txt"])
    await execGit(repo, ["commit", "-m", "local only"])
    const tip = await headSha(repo)

    const result = await reconcileIntegration({
      repoRoot: repo,
      repoName: "test-repo",
      branch: "feat/local",
      tipSha: tip,
      forge: new FakeForgeClient([], []),
      memo: new InMemoryVerdictMemoStore(),
      defaultBranchRef: "main",
      now: FROZEN_NOW,
    })
    expect(result).toEqual({ state: "local-only", checkedAt: FROZEN_NOW() })
  })

  it("step 4: pushed-no-pr / unpushed via a real bare origin remote", async () => {
    const repo = await makeRepo()
    cleanupPaths.push(repo)
    const origin = await mkdtemp(join(tmpdir(), "wt-status-origin-"))
    cleanupPaths.push(origin)
    await execGit(origin, ["init", "--bare", "-b", "main"])
    await execGit(repo, ["remote", "add", "origin", origin])
    await execGit(repo, ["push", "origin", "main"])

    await execGit(repo, ["checkout", "-b", "feat/synced"])
    await writeFile(join(repo, "a.txt"), "a\n")
    await execGit(repo, ["add", "a.txt"])
    await execGit(repo, ["commit", "-m", "synced commit"])
    await execGit(repo, ["push", "-u", "origin", "feat/synced"])
    const syncedTip = await headSha(repo)

    const syncedResult = await reconcileIntegration({
      repoRoot: repo,
      repoName: "test-repo",
      branch: "feat/synced",
      tipSha: syncedTip,
      forge: new FakeForgeClient([], []),
      memo: new InMemoryVerdictMemoStore(),
      defaultBranchRef: "main",
      now: FROZEN_NOW,
    })
    expect(syncedResult).toEqual({ state: "pushed-no-pr", checkedAt: FROZEN_NOW() })

    await writeFile(join(repo, "b.txt"), "b\n")
    await execGit(repo, ["add", "b.txt"])
    await execGit(repo, ["commit", "-m", "one more, unpushed"])
    const aheadTip = await headSha(repo)

    const unpushedResult = await reconcileIntegration({
      repoRoot: repo,
      repoName: "test-repo",
      branch: "feat/synced",
      tipSha: aheadTip,
      forge: new FakeForgeClient([], []),
      memo: new InMemoryVerdictMemoStore(),
      defaultBranchRef: "main",
      now: FROZEN_NOW,
    })
    expect(unpushedResult).toEqual({ state: "unpushed", aheadBy: 1, checkedAt: FROZEN_NOW() })
  })

  it("step 4: gone-unexplained when the upstream was deleted on the remote", async () => {
    const repo = await makeRepo()
    cleanupPaths.push(repo)
    const origin = await mkdtemp(join(tmpdir(), "wt-status-origin-"))
    cleanupPaths.push(origin)
    await execGit(origin, ["init", "--bare", "-b", "main"])
    await execGit(repo, ["remote", "add", "origin", origin])
    await execGit(repo, ["push", "origin", "main"])
    await execGit(repo, ["checkout", "-b", "feat/deleted-upstream"])
    await writeFile(join(repo, "a.txt"), "a\n")
    await execGit(repo, ["add", "a.txt"])
    await execGit(repo, ["commit", "-m", "commit"])
    await execGit(repo, ["push", "-u", "origin", "feat/deleted-upstream"])
    const tip = await headSha(repo)

    // Delete the branch on "origin" then prune — this is how git actually produces "[gone]".
    await execGit(origin, ["branch", "-D", "feat/deleted-upstream"])
    await execGit(repo, ["fetch", "--prune", "origin"])

    const result = await reconcileIntegration({
      repoRoot: repo,
      repoName: "test-repo",
      branch: "feat/deleted-upstream",
      tipSha: tip,
      forge: new FakeForgeClient([], []),
      memo: new InMemoryVerdictMemoStore(),
      defaultBranchRef: "main",
      now: FROZEN_NOW,
    })
    expect(result).toEqual({ state: "gone-unexplained", checkedAt: FROZEN_NOW() })
  })

  it("step 0: detached short-circuits without touching the forge", async () => {
    const repo = await makeRepo()
    cleanupPaths.push(repo)
    const tip = await headSha(repo)
    const result = await reconcileIntegration({
      repoRoot: repo,
      repoName: "test-repo",
      branch: null,
      tipSha: tip,
      forge: new UnreachableForgeClient("must not be called"),
      memo: new InMemoryVerdictMemoStore(),
      defaultBranchRef: "main",
      now: FROZEN_NOW,
    })
    expect(result).toEqual({ state: "detached", checkedAt: FROZEN_NOW() })
  })

  it("step 5: unknown(offline) when the forge is unreachable and there is no memo entry — never guesses", async () => {
    const repo = await makeRepo()
    cleanupPaths.push(repo)
    await execGit(repo, ["checkout", "-b", "feat/offline"])
    await writeFile(join(repo, "a.txt"), "a\n")
    await execGit(repo, ["add", "a.txt"])
    await execGit(repo, ["commit", "-m", "commit"])
    const tip = await headSha(repo)

    const result = await reconcileIntegration({
      repoRoot: repo,
      repoName: "test-repo",
      branch: "feat/offline",
      tipSha: tip,
      forge: new UnreachableForgeClient("simulated network outage"),
      memo: new InMemoryVerdictMemoStore(),
      defaultBranchRef: "main",
      now: FROZEN_NOW,
    })
    expect(result).toEqual({ state: "unknown", reason: "offline", checkedAt: FROZEN_NOW() })
  })

  it("step 5: a memo hit is returned, re-stamped offline:true, when the forge is unreachable", async () => {
    const repo = await makeRepo()
    cleanupPaths.push(repo)
    await execGit(repo, ["checkout", "-b", "feat/squash-memo"])
    await writeFile(join(repo, "a.txt"), "a\n")
    await execGit(repo, ["add", "a.txt"])
    await execGit(repo, ["commit", "-m", "commit"])
    const tip = await headSha(repo)
    await execGit(repo, ["checkout", "main"])
    await writeFile(join(repo, "unrelated.txt"), "u\n")
    await execGit(repo, ["add", "unrelated.txt"])
    await execGit(repo, ["commit", "-m", "main moved on"])

    const memo = new InMemoryVerdictMemoStore()
    const reachableForge = new FakeForgeClient([pr({ number: 5, headRefOid: tip, headRefName: "feat/squash-memo" })])
    const live = await reconcileIntegration({
      repoRoot: repo,
      repoName: "test-repo",
      branch: "feat/squash-memo",
      tipSha: tip,
      forge: reachableForge,
      memo,
      defaultBranchRef: "main",
      now: FROZEN_NOW,
    })
    expect(live).toEqual({ state: "merged", via: "squash", pr: 5, checkedAt: FROZEN_NOW(), offline: false })

    const laterClock = () => "2026-07-16T00:00:00.000Z"
    const offline = await reconcileIntegration({
      repoRoot: repo,
      repoName: "test-repo",
      branch: "feat/squash-memo",
      tipSha: tip,
      forge: new UnreachableForgeClient("simulated network outage"),
      memo,
      defaultBranchRef: "main",
      now: laterClock,
    })
    expect(offline).toEqual({ state: "merged", via: "squash", pr: 5, checkedAt: laterClock(), offline: true })
  })
})

describe("classify (PLAN.md §1.2)", () => {
  const CLEAN = { state: "clean" as const }
  const DIRTY = { state: "dirty" as const, modified: 1, staged: 0, untracked: 0 }
  const IDLE = { state: "idle" as const, sessions: [] as never[], services: [] as never[] }
  const DAEMON_UNREACHABLE = { state: "daemon-unreachable" as const, sessions: [] as never[], services: [] as never[] }
  const LIVE = { state: "sessions" as const, sessions: [{ id: "s1", startedAt: "t", status: "running" }], services: [] as never[] }
  const MERGED_ANCESTRY: IntegrationState = { state: "merged", via: "ancestry", checkedAt: "t" }
  const OPEN: IntegrationState = { state: "open", pr: 1, checkedAt: "t", offline: false }

  it("merged + clean + idle => reclaim", () => {
    expect(classify(CLEAN, MERGED_ANCESTRY, IDLE)).toEqual({ reclaimable: true, class: "reclaim" })
  })

  it("merged + clean + daemon-unreachable => still reclaim (git's own refusal is the safety net)", () => {
    expect(classify(CLEAN, MERGED_ANCESTRY, DAEMON_UNREACHABLE)).toEqual({ reclaimable: true, class: "reclaim" })
  })

  it("merged + clean + a live session => hold, not reclaim", () => {
    expect(classify(CLEAN, MERGED_ANCESTRY, LIVE)).toEqual({ reclaimable: false, class: "hold" })
  })

  it("merged + dirty => salvage", () => {
    expect(classify(DIRTY, MERGED_ANCESTRY, IDLE)).toEqual({ reclaimable: false, class: "salvage" })
  })

  it("open PR, even clean+idle => hold", () => {
    expect(classify(CLEAN, OPEN, IDLE)).toEqual({ reclaimable: false, class: "hold" })
  })
})

describe("listGitWorktrees + computeWorktreeStatus orchestration", () => {
  const cleanupPaths: string[] = []
  afterEach(async () => {
    while (cleanupPaths.length) await rm(cleanupPaths.pop()!, { recursive: true, force: true })
  })

  it("parses linked worktrees, including a detached one, and orchestrates all axes end to end", async () => {
    const repo = await makeRepo()
    cleanupPaths.push(repo)
    const initialTip = await headSha(repo)

    const linkedPath = join(repo, "..", `linked-${Math.random().toString(36).slice(2)}`)
    cleanupPaths.push(linkedPath)
    await addWorktree(repo, linkedPath, ["-b", "feat/linked"], "main")

    const detachedPath = join(repo, "..", `detached-${Math.random().toString(36).slice(2)}`)
    cleanupPaths.push(detachedPath)
    await addWorktree(repo, detachedPath, ["--detach"], initialTip)

    const worktrees = await listGitWorktrees(repo)
    const paths = worktrees.map((w) => w.path)
    expect(paths).toContain(repo)
    expect(paths).toContain(linkedPath)
    expect(paths).toContain(detachedPath)
    const detachedEntry = worktrees.find((w) => w.path === detachedPath)
    expect(detachedEntry?.branch).toBeNull()

    const status = await computeWorktreeStatus({
      repoRoot: repo,
      repoName: "test-repo",
      worktree: worktrees.find((w) => w.path === linkedPath)!,
      forge: new FakeForgeClient([], []),
      memo: new InMemoryVerdictMemoStore(),
      defaultBranchRef: "main",
      sessionsPath: join(repo, "no-such-sessions.json"),
      now: FROZEN_NOW,
    })
    expect(status.tree).toEqual({ state: "clean" })
    expect(status.integration).toEqual({ state: "merged", via: "ancestry", checkedAt: FROZEN_NOW() })
    expect(status.liveness).toEqual({ state: "idle", sessions: [], services: [] })
    expect(status.provenance).toEqual({ confidence: "best-effort", sessions: [] })
    expect(status.gate).toEqual({ state: "none" })
    expect(status.reclaimable).toBe(true)
    expect(status.class).toBe("reclaim")
  })
})

describe("determinism — same repo state, two runs, byte-identical JSON (PLAN.md §7.9)", () => {
  const cleanupPaths: string[] = []
  afterEach(async () => {
    while (cleanupPaths.length) await rm(cleanupPaths.pop()!, { recursive: true, force: true })
  })

  it("cold memo, twice, produce byte-identical status JSON", async () => {
    const repo = await makeRepo()
    cleanupPaths.push(repo)
    await execGit(repo, ["checkout", "-b", "feat/deterministic"])
    await writeFile(join(repo, "a.txt"), "a\n")
    await execGit(repo, ["add", "a.txt"])
    await execGit(repo, ["commit", "-m", "commit A"])
    const tip = await headSha(repo)
    await execGit(repo, ["checkout", "main"])
    await writeFile(join(repo, "unrelated.txt"), "u\n")
    await execGit(repo, ["add", "unrelated.txt"])
    await execGit(repo, ["commit", "-m", "main moved on"])
    await execGit(repo, ["checkout", "feat/deterministic"])

    const worktree = { path: repo, branch: "feat/deterministic", head: tip }
    const makeForge = () => new FakeForgeClient([pr({ number: 7, headRefOid: tip, headRefName: "feat/deterministic" })])

    const run1 = await computeWorktreeStatus({
      repoRoot: repo,
      repoName: "test-repo",
      worktree,
      forge: makeForge(),
      memo: new InMemoryVerdictMemoStore(),
      defaultBranchRef: "main",
      sessionsPath: join(repo, "no-such-sessions.json"),
      now: FROZEN_NOW,
    })
    const run2 = await computeWorktreeStatus({
      repoRoot: repo,
      repoName: "test-repo",
      worktree,
      forge: makeForge(),
      memo: new InMemoryVerdictMemoStore(),
      defaultBranchRef: "main",
      sessionsPath: join(repo, "no-such-sessions.json"),
      now: FROZEN_NOW,
    })
    expect(JSON.stringify(run1)).toBe(JSON.stringify(run2))
  })
})

describe("FileVerdictMemoStore", () => {
  const cleanupPaths: string[] = []
  afterEach(async () => {
    while (cleanupPaths.length) await rm(cleanupPaths.pop()!, { recursive: true, force: true })
  })

  it("round-trips a record through disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wt-memo-"))
    cleanupPaths.push(dir)
    const path = join(dir, "worktree-verdicts.json")
    const record = {
      repo: "test-repo",
      branch: "feat/x",
      tipSha: "deadbeef",
      verdict: { state: "merged", via: "squash", pr: 1, checkedAt: "t", offline: false } as IntegrationState,
      checkedAt: "t",
    }
    const store = new FileVerdictMemoStore(path)
    await store.set(record)
    const reread = new FileVerdictMemoStore(path)
    expect(await reread.get("test-repo", "feat/x", "deadbeef")).toEqual(record)
  })

  it("treats a corrupt memo file as empty, not an error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wt-memo-"))
    cleanupPaths.push(dir)
    const path = join(dir, "worktree-verdicts.json")
    await writeFile(path, "not json")
    const store = new FileVerdictMemoStore(path)
    expect(await store.get("test-repo", "feat/x", "deadbeef")).toBeNull()
  })

  it("a missing file is an empty store, not an error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wt-memo-"))
    cleanupPaths.push(dir)
    const store = new FileVerdictMemoStore(join(dir, "does-not-exist.json"))
    expect(await store.get("test-repo", "feat/x", "deadbeef")).toBeNull()
  })
})

describe("ForgeUnavailableError propagation shape", () => {
  it("is a typed error distinguishable from a legitimate empty result", async () => {
    const forge: ForgeClient = new UnreachableForgeClient("no gh, no token")
    await expect(forge.pullRequestsForBranch("x")).rejects.toBeInstanceOf(ForgeUnavailableError)
  })
})

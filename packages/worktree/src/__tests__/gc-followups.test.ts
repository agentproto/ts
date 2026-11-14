/**
 * Dogfood follow-ups for `worktree gc` / `ls --status`: stale-plan re-check,
 * session-backed liveness, conditional lockfile noise, the `closed-unmerged`
 * integration state, and the speed work (parallel sweep, verdict-memo hit,
 * race-free memo writes). Real disposable git repos; the forge is a double.
 */
import { describe, it, expect, afterEach, vi } from "vitest"
import { mkdtemp, rm, writeFile, realpath, readFile, utimes } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { execGit } from "../exec.js"
import { planGc, applyGc, type GcApplyOutcome } from "../gc.js"
import { mapWithConcurrency } from "../concurrency.js"
import {
  computeLiveness,
  computeTreeState,
  FileVerdictMemoStore,
  InMemoryVerdictMemoStore,
  listWorktreeStatuses,
  livenessSessionCount,
  reconcileIntegration,
  type VerdictMemoStore,
} from "../status.js"
import type { ForgeClient, ForgePullRequestRef } from "../forge.js"

vi.setConfig({ testTimeout: 60_000 })

const cleanupPaths: string[] = []
afterEach(async () => {
  while (cleanupPaths.length > 0) {
    const p = cleanupPaths.pop() as string
    await rm(p, { recursive: true, force: true }).catch(() => {})
  }
})

const FROZEN_NOW = () => "2026-07-15T00:00:00.000Z"
const OLD = 61 * 60 * 1000

async function makeRepo(): Promise<string> {
  const repo = await realpath(await mkdtemp(join(tmpdir(), "wt-follow-")))
  cleanupPaths.push(repo)
  await execGit(repo, ["init", "-b", "main"])
  await execGit(repo, ["config", "user.email", "t@e.com"])
  await execGit(repo, ["config", "user.name", "T"])
  await writeFile(join(repo, "README.md"), "hello\n")
  await writeFile(join(repo, "package.json"), '{"name":"root"}\n')
  await writeFile(join(repo, "pnpm-lock.yaml"), "lockfileVersion: '1.0'\n")
  await execGit(repo, ["add", "."])
  await execGit(repo, ["commit", "-m", "init"])
  return repo
}

async function headSha(cwd: string): Promise<string> {
  return (await execGit(cwd, ["rev-parse", "HEAD"])).stdout.trim()
}

async function indexPath(wtPath: string): Promise<string> {
  return (await execGit(wtPath, ["rev-parse", "--path-format=absolute", "--git-path", "index"])).stdout.trim()
}

async function backdateIndex(wtPath: string, ageMs = OLD): Promise<void> {
  const old = new Date(Date.now() - ageMs)
  await utimes(await indexPath(wtPath), old, old)
}

async function backdate(path: string, ageMs = OLD): Promise<void> {
  const old = new Date(Date.now() - ageMs)
  await utimes(path, old, old)
}

/** A branch with one commit of its own, plus an idle worktree on it (index aged past the guard). */
async function branchWorktree(repo: string, branch: string): Promise<{ wtPath: string; tip: string }> {
  await execGit(repo, ["checkout", "-b", branch])
  await writeFile(join(repo, `${branch.replace(/\W/g, "-")}.txt`), "x\n")
  await execGit(repo, ["add", "."])
  await execGit(repo, ["commit", "-m", `work on ${branch}`])
  const tip = await headSha(repo)
  await execGit(repo, ["checkout", "main"])
  const wtPath = join(repo, "..", `${branch.replace(/\W/g, "-")}-${Math.random().toString(36).slice(2)}`)
  cleanupPaths.push(wtPath)
  await execGit(repo, ["worktree", "add", wtPath, branch])
  await backdateIndex(wtPath)
  return { wtPath, tip }
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

class FakeForge implements ForgeClient {
  calls = 0
  constructor(private readonly prs: ForgePullRequestRef[] = []) {}
  async pullRequestsForBranch(): Promise<ForgePullRequestRef[]> {
    this.calls++
    return this.prs
  }
  async pullRequestsForCommit(): Promise<ForgePullRequestRef[]> {
    this.calls++
    return this.prs
  }
  async ensurePullHeadFetched(): Promise<void> {}
}

function gcInput(repo: string, forge: ForgeClient, memo: VerdictMemoStore = new InMemoryVerdictMemoStore()) {
  return { repoRoot: repo, repoName: "test-repo", forge, memo, defaultBranchRef: "main", now: FROZEN_NOW }
}

// ── item 6: closed-unmerged ─────────────────────────────────────────────

describe("integration state: closed-unmerged", () => {
  it("a branch whose only PR was closed without merging reads closed-unmerged(#N), not pushed-no-pr", async () => {
    const repo = await makeRepo()
    const { tip } = await branchWorktree(repo, "feat/abandoned")
    const closed = pr({ number: 1156, headRefOid: tip, merged: false, mergedAt: null, headRefName: "feat/abandoned" })
    const state = await reconcileIntegration({
      repoRoot: repo,
      repoName: "test-repo",
      branch: "feat/abandoned",
      tipSha: tip,
      forge: new FakeForge([closed]),
      memo: new InMemoryVerdictMemoStore(),
      defaultBranchRef: "main",
      now: FROZEN_NOW,
    })
    expect(state).toEqual({ state: "closed-unmerged", pr: 1156, checkedAt: FROZEN_NOW(), offline: false })
  })

  it("an open PR still wins over an older closed one, and a merged PR over both", async () => {
    const repo = await makeRepo()
    const { tip } = await branchWorktree(repo, "feat/reopened")
    const closed = pr({ number: 10, headRefOid: tip, merged: false, mergedAt: null })
    const open = pr({ number: 11, headRefOid: tip, state: "open", merged: false, mergedAt: null })
    const state = await reconcileIntegration({
      repoRoot: repo,
      repoName: "test-repo",
      branch: "feat/reopened",
      tipSha: tip,
      forge: new FakeForge([closed, open]),
      memo: new InMemoryVerdictMemoStore(),
      defaultBranchRef: "main",
      now: FROZEN_NOW,
    })
    expect(state.state).toBe("open")
  })

  it("gc holds a clean idle closed-unmerged worktree (never reclaimed on the closed PR alone)", async () => {
    const repo = await makeRepo()
    const { wtPath, tip } = await branchWorktree(repo, "feat/closed-hold")
    const forge = new FakeForge([pr({ number: 971, headRefOid: tip, merged: false, mergedAt: null })])
    const plan = await planGc(gcInput(repo, forge))
    const entry = plan.find((e) => e.path === wtPath)
    expect(entry?.integration).toMatchObject({ state: "closed-unmerged", pr: 971 })
    expect(entry?.class).toBe("hold")
  })
})

// ── item 4: conditional lockfile noise ──────────────────────────────────

describe("pnpm-lock.yaml is noise only while no package.json changed", () => {
  const opts = { conditionalNoisePaths: ["pnpm-lock.yaml"] }

  it("lockfile-only churn reads clean (with the noise recorded)", async () => {
    const repo = await makeRepo()
    await writeFile(join(repo, "pnpm-lock.yaml"), "churn\n")
    expect(await computeTreeState(repo, repo, opts)).toEqual({ state: "clean", noise: ["pnpm-lock.yaml"] })
  })

  it("lockfile next to a modified package.json stays real dirt (both paths)", async () => {
    const repo = await makeRepo()
    await writeFile(join(repo, "pnpm-lock.yaml"), "churn\n")
    await writeFile(join(repo, "package.json"), '{"name":"root","dependencies":{"left-pad":"1"}}\n')
    const tree = await computeTreeState(repo, repo, opts)
    expect(tree).toMatchObject({ state: "dirty", modified: 2 })
  })

  it("a nested package.json change also makes the lockfile real", async () => {
    const repo = await makeRepo()
    await execGit(repo, ["checkout", "-q", "-b", "scratch"])
    await execGit(repo, ["checkout", "-q", "main"])
    await writeFile(join(repo, "pnpm-lock.yaml"), "churn\n")
    await writeFile(join(repo, "sub-package.json"), "{}\n") // not a manifest: still noise-only
    expect((await computeTreeState(repo, repo, opts)).state).toBe("dirty") // untracked file is real dirt
    const nested = join(repo, "packages", "a")
    await execGit(repo, ["rm", "-q", "--cached", "-r", "."]).catch(() => {})
    await execGit(repo, ["reset", "-q"])
    await rm(join(repo, "sub-package.json"))
    await execGit(repo, ["checkout", "--", "."])
    await writeFile(join(repo, "pnpm-lock.yaml"), "churn\n")
    await (await import("node:fs/promises")).mkdir(nested, { recursive: true })
    await writeFile(join(nested, "package.json"), "{}\n")
    const tree = await computeTreeState(repo, repo, opts)
    expect(tree.state).toBe("dirty")
  })

  it("gc by default: lockfile-only reclaims, lockfile + package.json salvages, explicit --noise keeps its old meaning", async () => {
    const repo = await makeRepo()
    const { wtPath, tip } = await branchWorktree(repo, "wt/lock-cond")
    const forge = new FakeForge([pr({ number: 7, headRefOid: tip, headRefName: "wt/lock-cond" })])

    await writeFile(join(wtPath, "pnpm-lock.yaml"), "churn\n")
    await backdate(join(wtPath, "pnpm-lock.yaml"))
    const lockOnly = await planGc(gcInput(repo, forge))
    expect(lockOnly.find((e) => e.path === wtPath)?.class).toBe("reclaim")

    await writeFile(join(wtPath, "package.json"), '{"name":"root","dependencies":{"x":"1"}}\n')
    await backdate(join(wtPath, "package.json"))
    const withManifest = await planGc(gcInput(repo, forge))
    expect(withManifest.find((e) => e.path === wtPath)?.class).toBe("salvage")

    // The override names pnpm-lock.yaml and package.json explicitly: taken literally, whatever else changed.
    const overridden = await planGc({ ...gcInput(repo, forge), noisePaths: ["pnpm-lock.yaml", "package.json"] })
    expect(overridden.find((e) => e.path === wtPath)?.class).toBe("reclaim")
  })

  it("ls --status engine reads the same: listWorktreeStatuses with the conditional list sees a lockfile-only tree as clean", async () => {
    const repo = await makeRepo()
    const { wtPath } = await branchWorktree(repo, "wt/ls-lock")
    await writeFile(join(wtPath, "pnpm-lock.yaml"), "churn\n")
    const [entry] = (
      await listWorktreeStatuses({
        ...gcInput(repo, new FakeForge()),
        conditionalNoisePaths: ["pnpm-lock.yaml"],
      })
    ).filter((e) => e.path === wtPath)
    expect(entry?.tree.state).toBe("clean")
  })
})

// ── item 8: liveness from the daemon registry + dirty-file mtime ────────

describe("liveness from live session cwds", () => {
  it("computeLiveness counts daemon sessions at or under the worktree, with no snapshot match", async () => {
    const repo = await makeRepo()
    const { wtPath } = await branchWorktree(repo, "wt/live-a")
    const liveness = await computeLiveness(wtPath, {
      sessionsRegistry: [],
      liveSessionCwds: [wtPath, join(wtPath, "packages", "x"), `${wtPath}-sibling`],
    })
    expect(liveness.state).toBe("sessions")
    expect(livenessSessionCount(liveness)).toBe(2)
  })

  it("without cwds the snapshot alone decides (daemon unreachable fallback)", async () => {
    const repo = await makeRepo()
    const { wtPath } = await branchWorktree(repo, "wt/live-b")
    const liveness = await computeLiveness(wtPath, { sessionsRegistry: [] })
    expect(liveness.state).toBe("idle")
    expect(livenessSessionCount(liveness)).toBe(0)
  })

  it("planGc fills sessionCount from liveSessionCwds and holds the worktree even when it is merged and clean", async () => {
    const repo = await makeRepo()
    const { wtPath, tip } = await branchWorktree(repo, "wt/live-c")
    const forge = new FakeForge([pr({ number: 3, headRefOid: tip })])
    const idle = await planGc(gcInput(repo, forge))
    expect(idle.find((e) => e.path === wtPath)?.class).toBe("reclaim")

    const live = await planGc({ ...gcInput(repo, forge), liveSessionCwds: [join(wtPath, "src")] })
    const entry = live.find((e) => e.path === wtPath)
    expect(entry?.class).toBe("hold")
    expect(entry?.liveness && livenessSessionCount(entry.liveness)).toBe(1)
  })

  it("a merged worktree with a freshly written dirty file holds even when its index is old", async () => {
    const repo = await makeRepo()
    const { wtPath, tip } = await branchWorktree(repo, "wt/live-d")
    const forge = new FakeForge([pr({ number: 4, headRefOid: tip })])
    await writeFile(join(wtPath, "notes.txt"), "being typed right now\n")
    const plan = await planGc({ ...gcInput(repo, forge), nowMs: Date.now() })
    const entry = plan.find((e) => e.path === wtPath)
    expect(entry?.class).toBe("hold")
    expect(entry?.holdReason).toBe("recent-activity")

    await backdate(join(wtPath, "notes.txt"))
    const later = await planGc(gcInput(repo, forge))
    expect(later.find((e) => e.path === wtPath)?.class).toBe("salvage")
  })
})

// ── item 3: stale plan at apply time ────────────────────────────────────

describe("applyGc skips an entry whose worktree changed since the plan", () => {
  async function plannedReclaim() {
    const repo = await makeRepo()
    const { wtPath, tip } = await branchWorktree(repo, "wt/stale")
    const forge = new FakeForge([pr({ number: 5, headRefOid: tip })])
    const input = gcInput(repo, forge)
    const plan = await planGc(input)
    expect(plan.find((e) => e.path === wtPath)?.class).toBe("reclaim")
    return { repo, wtPath, tip, forge, input, plan }
  }

  it("untouched worktree still reclaims from the plan", async () => {
    const { wtPath, input, plan } = await plannedReclaim()
    const outcome = (await applyGc(plan, input)).find((o) => o.path === wtPath)
    expect(outcome?.result).toBe("reclaimed")
  })

  it("HEAD moved after the plan (a new commit on a still-merged branch): skipped-stale, nothing removed", async () => {
    const { repo, wtPath, input, plan } = await plannedReclaim()
    await writeFile(join(wtPath, "later.txt"), "new work\n")
    await execGit(wtPath, ["add", "."])
    await execGit(wtPath, ["commit", "-m", "work after the plan"])
    await backdateIndex(wtPath) // isolate the HEAD check: the commit's own index touch would reclassify first
    // The forge now reports the new tip as merged too, so only the staleness check can object.
    const forge = new FakeForge([pr({ number: 5, headRefOid: await headSha(wtPath) })])
    const outcome = (await applyGc(plan, { ...input, forge })).find((o) => o.path === wtPath) as GcApplyOutcome
    expect(outcome.result).toBe("skipped-stale")
    expect((outcome as { reason: string }).reason).toMatch(/HEAD moved/)
    expect((await execGit(repo, ["worktree", "list", "--porcelain"])).stdout).toContain(wtPath)
  })

  it("a git command in the worktree after the plan (index mtime moved): skipped-stale", async () => {
    const { repo, wtPath, input, plan } = await plannedReclaim()
    const now = new Date(Date.now() - 30 * 60 * 1000)
    await utimes(await indexPath(wtPath), now, now) // still outside nothing: only the mtime differs from the plan's
    const outcome = (await applyGc(plan, { ...input, activeMinutes: 0 })).find((o) => o.path === wtPath) as GcApplyOutcome
    expect(outcome.result).toBe("skipped-stale")
    expect((outcome as { reason: string }).reason).toMatch(/index/)
    expect((await execGit(repo, ["worktree", "list", "--porcelain"])).stdout).toContain(wtPath)
  })

  it("a session that appeared after the plan is never reclaimed under", async () => {
    const { repo, wtPath, input, plan } = await plannedReclaim()
    const outcome = (await applyGc(plan, { ...input, liveSessionCwds: [wtPath] })).find((o) => o.path === wtPath) as GcApplyOutcome
    expect(outcome.result).toBe("aborted-reclassified")
    expect((await execGit(repo, ["worktree", "list", "--porcelain"])).stdout).toContain(wtPath)
  })
})

// ── item 10: speed ──────────────────────────────────────────────────────

describe("sweep speed", () => {
  it("mapWithConcurrency preserves order, honours the limit, and rethrows the first failure", async () => {
    let inFlight = 0
    let peak = 0
    const out = await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7, 8], 3, async (n) => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight--
      return n * 2
    })
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14, 16])
    expect(peak).toBe(3)
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error("boom")
        return n
      }),
    ).rejects.toThrow("boom")
  })

  it("a parallel plan is identical to a serial one and reports progress for every worktree", async () => {
    const repo = await makeRepo()
    const made = []
    for (const b of ["wt/par-a", "wt/par-b", "wt/par-c", "wt/par-d"]) made.push(await branchWorktree(repo, b))
    const forge = new FakeForge([pr({ number: 9, headRefOid: made[0]?.tip as string })])
    const progress: number[] = []
    const parallel = await planGc({ ...gcInput(repo, forge), concurrency: 4, onProgress: (done, total) => progress.push(done * 100 + total) })
    const serial = await planGc({ ...gcInput(repo, forge), concurrency: 1 })
    expect(parallel).toEqual(serial)
    expect(progress.sort()).toEqual([104, 204, 304, 404])
  })

  it("a memoised merged verdict is served without asking the forge again (the cache is hit)", async () => {
    const repo = await makeRepo()
    const { wtPath, tip } = await branchWorktree(repo, "wt/memo-hit")
    const memo = new InMemoryVerdictMemoStore()
    const first = new FakeForge([pr({ number: 12, headRefOid: tip })])
    await planGc(gcInput(repo, first, memo))
    expect(first.calls).toBeGreaterThan(0)

    const second = new FakeForge([])
    const plan = await planGc(gcInput(repo, second, memo))
    expect(second.calls).toBe(0)
    const entry = plan.find((e) => e.path === wtPath)
    expect(entry?.integration).toMatchObject({ state: "merged", pr: 12, offline: false })
    expect(entry?.class).toBe("reclaim")
  })

  it("concurrent memo writes leave one valid JSON file holding every record", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "wt-memo-")))
    cleanupPaths.push(dir)
    const path = join(dir, "worktree-verdicts.json")
    const store = new FileVerdictMemoStore(path)
    await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        store.set({
          repo: "r",
          branch: `b${i}`,
          tipSha: `sha${i}`,
          verdict: { state: "merged", via: "squash", pr: i, checkedAt: "t", offline: false },
          checkedAt: "t",
        }),
      ),
    )
    const parsed = JSON.parse(await readFile(path, "utf8")) as { entries: unknown[] }
    expect(parsed.entries).toHaveLength(40)
  })
})

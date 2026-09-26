/**
 * `branch gc` tests. Every tier is driven against a real disposable git repo
 * (plus a bare repo standing in for `origin` where remote refs matter) — the
 * same posture as `gc.test.ts`: a mocked git proves nothing about the ladder.
 * The forge is always a test double.
 */
import { describe, it, expect, afterEach, vi } from "vitest"
import { mkdtemp, rm, writeFile, mkdir, realpath } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"

import { execGit, execArgv } from "../exec.js"
import {
  planBranchGc,
  applyBranchGc,
  branchReviewQueue,
  summarizeBranchGcPlan,
  readBranchGcRestoreLog,
  recordBranchVerdict,
  classifyTip,
  createLadderContext,
  InMemoryBranchVerdictStore,
  BranchVerdictError,
  type BranchGcPlan,
  type BranchGcPlanEntry,
  type PlanBranchGcInput,
} from "../branch-gc.js"
import type { ForgeClient, ForgePullRequestRef } from "../forge.js"

// Real git fixtures: dozens of spawns per test.
vi.setConfig({ testTimeout: 60_000 })

const cleanupPaths: string[] = []
afterEach(async () => {
  while (cleanupPaths.length) await rm(cleanupPaths.pop() as string, { recursive: true, force: true })
})

async function tmp(prefix: string): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  cleanupPaths.push(dir)
  return dir
}

async function makeRepo(branch = "main"): Promise<string> {
  const repo = await tmp("branch-gc-")
  await execGit(repo, ["init", "-b", branch])
  await execGit(repo, ["config", "user.email", "t@e.com"])
  await execGit(repo, ["config", "user.name", "T"])
  await commitFiles(repo, { "README.md": "hello\n" }, "init")
  return repo
}

async function commitFiles(repo: string, files: Record<string, string | null>, message: string): Promise<string> {
  for (const [path, content] of Object.entries(files)) {
    const abs = join(repo, path)
    if (content === null) {
      await execGit(repo, ["rm", "-q", path])
      continue
    }
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, content)
    await execGit(repo, ["add", "-f", path])
  }
  await execGit(repo, ["commit", "-q", "--allow-empty", "-m", message])
  return sha(repo, "HEAD")
}

async function sha(repo: string, ref: string): Promise<string> {
  return (await execGit(repo, ["rev-parse", ref])).stdout.trim()
}

async function refExists(repo: string, ref: string): Promise<boolean> {
  return (await execArgv("git", ["-C", repo, "rev-parse", "--verify", "--quiet", ref], repo)).exitCode === 0
}

/** Cut `branch` from `from`, commit `files`, return to `back`. */
async function branchWith(
  repo: string,
  branch: string,
  files: Record<string, string | null>,
  from = "main",
  back = "main",
): Promise<string> {
  await execGit(repo, ["checkout", "-q", "-b", branch, from])
  const tip = await commitFiles(repo, files, `${branch} work`)
  await execGit(repo, ["checkout", "-q", back])
  return tip
}

class FakeForge implements ForgeClient {
  constructor(private readonly open: ForgePullRequestRef[] = []) {}
  async pullRequestsForBranch(): Promise<ForgePullRequestRef[]> {
    return []
  }
  async pullRequestsForCommit(): Promise<ForgePullRequestRef[]> {
    return []
  }
  async ensurePullHeadFetched(): Promise<void> {}
  async listOpenPullRequests(): Promise<ForgePullRequestRef[]> {
    return this.open
  }
}

function openPr(number: number, headRefName: string): ForgePullRequestRef {
  return { number, state: "open", merged: false, mergedAt: null, headRefName, headRefOid: "0".repeat(40) }
}

function plan(repo: string, extra: Partial<PlanBranchGcInput> = {}): Promise<BranchGcPlan> {
  return planBranchGc({ repoRoot: repo, repoName: "fixture", base: "main", forge: new FakeForge(), minAgeDays: 0, ...extra })
}

function entry(p: BranchGcPlan, name: string, kind: BranchGcPlanEntry["kind"] = "local"): BranchGcPlanEntry {
  const e = p.entries.find((x) => x.name === name && x.kind === kind)
  if (!e) throw new Error(`no ${kind} entry ${name} in plan: ${p.entries.map((x) => `${x.kind}:${x.name}`).join(", ")}`)
  return e
}

// ── the ladder, one fixture per tier ─────────────────────────────────────

describe("branch gc — reclaim ladder", () => {
  it("merged: tip is an ancestor of base", async () => {
    const repo = await makeRepo()
    await branchWith(repo, "feat/ff", { "a.txt": "a\n" })
    await execGit(repo, ["merge", "-q", "--ff-only", "feat/ff"])
    const e = entry(await plan(repo), "feat/ff")
    expect(e).toMatchObject({ status: "merged", class: "reclaim", reclaimReason: "merged", history: "current" })
  })

  it("squash-merged: merging it into base changes nothing", async () => {
    const repo = await makeRepo()
    await branchWith(repo, "feat/squash", { "a.txt": "a\n" })
    await branchWith(repo, "feat/squash-more", { "b.txt": "b\n" }, "feat/squash")
    // Base lands the same content as one squash commit, then moves on.
    await commitFiles(repo, { "a.txt": "a\n", "b.txt": "b\n" }, "squash of feat/squash (#1)")
    await commitFiles(repo, { "later.txt": "later\n" }, "later work")
    const p = await plan(repo)
    expect(entry(p, "feat/squash")).toMatchObject({ status: "squash-merged", class: "reclaim" })
    expect(entry(p, "feat/squash-more")).toMatchObject({ status: "squash-merged", class: "reclaim" })
  })

  it("patch-merged: cherry-picked, then base edited the same lines (merge-tree conflicts, cherry all -)", async () => {
    const repo = await makeRepo()
    await commitFiles(repo, { "conf.txt": "line1\nvalue=1\nline3\n" }, "conf")
    const tip = await branchWith(repo, "feat/picked", { "conf.txt": "line1\nvalue=2\nline3\n" })
    // Diverge first: a same-second cherry-pick onto the tip's own parent
    // would recreate the identical commit object (and read as `merged`).
    await commitFiles(repo, { "other.txt": "o\n" }, "unrelated base work")
    await execGit(repo, ["cherry-pick", tip])
    await commitFiles(repo, { "conf.txt": "line1\nvalue=3\nline3\n" }, "base keeps editing")
    const e = entry(await plan(repo), "feat/picked")
    expect(e).toMatchObject({ status: "patch-merged", class: "reclaim", conflicts: true })
  })

  it("content-merged: base squash-landed the work, then moved it (reorg) — by blob, any path", async () => {
    const repo = await makeRepo()
    await branchWith(repo, "feat/reorg", { "src/x.ts": "export const x = 1\n", "src/y.ts": "export const y = 2\n" })
    await commitFiles(repo, { "src/x.ts": "export const x = 1\n", "src/y.ts": "export const y = 2\n" }, "squash feat/reorg")
    await execGit(repo, ["mv", "src", "lib"])
    await commitFiles(repo, {}, "reorg: src → lib")
    const e = entry(await plan(repo), "feat/reorg")
    expect(e.status).toBe("content-merged")
    expect(e.class).toBe("reclaim")
    expect(e.coverage).toMatchObject({ covered: 2, evolved: 0, unique: 0, deletes: 0 })
  })

  it("content-merged: the only residual is gitignored in base", async () => {
    const repo = await makeRepo()
    await commitFiles(repo, { ".gitignore": "dist/\n" }, "ignore dist")
    await branchWith(repo, "feat/build", { "dist/out.js": "built\n" })
    const e = entry(await plan(repo), "feat/build")
    expect(e.status).toBe("content-merged")
    expect(e.coverage).toMatchObject({ residual: 1, ignored: 1, unique: 0 })
  })

  it("review: an evolved file (same name in base, other content)", async () => {
    const repo = await makeRepo()
    await commitFiles(repo, { "docs/NOTES.md": "base version\n" }, "notes")
    await branchWith(repo, "feat/evolved", { "other/NOTES.md": "branch version\n" })
    await commitFiles(repo, { "later.txt": "x\n" }, "later")
    const e = entry(await plan(repo), "feat/evolved")
    expect(e).toMatchObject({ status: "unmerged", class: "review" })
    expect(e.coverage).toMatchObject({ evolved: 1, unique: 0 })
    expect(e.residualFiles).toEqual(["other/NOTES.md"])
  })

  it("review: a unique file (no trace in base)", async () => {
    const repo = await makeRepo()
    await branchWith(repo, "feat/unique", { "brand-new.ts": "new\n" })
    await commitFiles(repo, { "later.txt": "x\n" }, "later")
    const e = entry(await plan(repo), "feat/unique")
    expect(e).toMatchObject({ status: "unmerged", class: "review", pushed: "local-only" })
    expect(e.coverage).toMatchObject({ unique: 1 })
    expect(e.mergeBase).toBeTruthy()
    expect(e.mergedTree).toMatch(/^[0-9a-f]{40}$/)
  })

  it("review: the branch deletes a file base still has", async () => {
    const repo = await makeRepo()
    await commitFiles(repo, { "keep.txt": "keep\n" }, "keep")
    await branchWith(repo, "feat/deleter", { "keep.txt": null })
    await commitFiles(repo, { "later.txt": "x\n" }, "later")
    const e = entry(await plan(repo), "feat/deleter")
    expect(e).toMatchObject({ status: "unmerged", class: "review" })
    expect(e.coverage).toMatchObject({ deletes: 1 })
    expect(e.residualFiles).toEqual(["keep.txt"])
  })

  it("young unmerged refs are held, not queued for review", async () => {
    const repo = await makeRepo()
    await branchWith(repo, "feat/fresh-work", { "n.ts": "n\n" })
    const e = entry(await plan(repo, { minAgeDays: 3 }), "feat/fresh-work")
    expect(e).toMatchObject({ status: "unmerged", class: "hold", holdReason: "young" })
  })
})

// ── re-rooted base ──────────────────────────────────────────────────────

describe("branch gc — re-rooted base + anchor", () => {
  it("auto-detects the anchor and classifies pre-rewrite tips against it", async () => {
    const repo = await makeRepo("old")
    const a = await sha(repo, "HEAD")
    await branchWith(repo, "feat/pre-merged", { "p.txt": "p\n" }, "old", "old")
    await branchWith(repo, "feat/pre-squashed", { "s.txt": "s\n" }, "old", "old")
    await branchWith(repo, "feat/pre-unique", { "u.txt": "u\n" }, "old", "old")
    await execGit(repo, ["merge", "-q", "--no-ff", "-m", "merge pre-merged", "feat/pre-merged"])
    const anchor = await commitFiles(repo, { "s.txt": "s\n" }, "squash pre-squashed")
    // History rewrite: a fresh root whose tree is the old history's snapshot.
    await execGit(repo, ["checkout", "-q", "--orphan", "main"])
    await execGit(repo, ["commit", "-q", "-m", "snapshot"])
    await commitFiles(repo, { "new.txt": "new\n" }, "post-rewrite work")

    const p = await plan(repo, { scopes: ["local"] })
    expect(p.anchor).toBe(anchor)
    expect(entry(p, "feat/pre-merged")).toMatchObject({ status: "merged", history: "pre-rewrite", class: "reclaim" })
    expect(entry(p, "feat/pre-squashed")).toMatchObject({ status: "squash-merged", history: "pre-rewrite" })
    const u = entry(p, "feat/pre-unique")
    expect(u).toMatchObject({ status: "unmerged", history: "pre-rewrite", class: "review", compareBase: anchor })
    expect(u.mergeBase).toBe(a)
  })

  it("without history in common and no anchor, a tip is unmerged/unrelated", async () => {
    const repo = await makeRepo()
    await execGit(repo, ["checkout", "-q", "--orphan", "island"])
    const island = await commitFiles(repo, { "i.txt": "i\n" }, "island")
    await execGit(repo, ["checkout", "-q", "main"])
    const ctx = await createLadderContext(repo, "main", null)
    expect(await classifyTip(ctx, island)).toMatchObject({ status: "unmerged", history: "unrelated", ahead: null })
  })
})

// ── ref kinds + holds ───────────────────────────────────────────────────

async function withOrigin(repo: string): Promise<string> {
  const bare = await tmp("branch-gc-origin-")
  await execGit(bare, ["init", "-q", "--bare", "-b", "main"])
  await execGit(repo, ["remote", "add", "origin", bare])
  await execGit(repo, ["push", "-q", "origin", "main"])
  await execGit(repo, ["fetch", "-q", "origin"])
  return bare
}

describe("branch gc — ref kinds and holds", () => {
  it("orphan namespace: refs of a removed remote are classified; only-copy is reported", async () => {
    const repo = await makeRepo()
    const merged = await branchWith(repo, "tmp-merged", { "m.txt": "m\n" })
    await execGit(repo, ["merge", "-q", "--ff-only", "tmp-merged"])
    const lost = await branchWith(repo, "tmp-lost", { "lost.txt": "only here\n" })
    await execGit(repo, ["update-ref", "refs/remotes/gone/feat-merged", merged])
    await execGit(repo, ["update-ref", "refs/remotes/gone/feat-lost", lost])
    await execGit(repo, ["branch", "-q", "-D", "tmp-merged", "tmp-lost"])

    const p = await plan(repo)
    expect(entry(p, "gone/feat-merged", "orphan")).toMatchObject({ class: "reclaim", status: "merged" })
    expect(entry(p, "gone/feat-lost", "orphan")).toMatchObject({ class: "review", pushed: "only-copy" })
  })

  it("a worktree's branch AND its remote twin are held; base is protected", async () => {
    const repo = await makeRepo()
    await withOrigin(repo)
    await branchWith(repo, "wt/live", { "w.txt": "w\n" })
    await execGit(repo, ["merge", "-q", "--ff-only", "wt/live"]) // merged — would otherwise reclaim
    await execGit(repo, ["push", "-q", "origin", "wt/live", "main"])
    await execGit(repo, ["fetch", "-q", "origin"])
    const wtPath = join(await tmp("branch-gc-wt-"), "live")
    await execGit(repo, ["worktree", "add", "-q", wtPath, "wt/live"])

    const p = await plan(repo, { base: "origin/main" })
    expect(entry(p, "wt/live")).toMatchObject({ class: "hold", holdReason: "worktree", holdDetail: wtPath })
    expect(entry(p, "wt/live", "remote")).toMatchObject({ class: "hold", holdReason: "worktree" })
    expect(entry(p, "main")).toMatchObject({ class: "hold", holdReason: "protected" })
    expect(entry(p, "main", "remote")).toMatchObject({ class: "hold", holdReason: "protected" })
  })

  it("open PR heads are held; an unavailable PR check holds every local/remote ref but not orphans", async () => {
    const repo = await makeRepo()
    await branchWith(repo, "feat/pr", { "a.txt": "a\n" })
    await branchWith(repo, "feat/other", { "b.txt": "b\n" })
    await execGit(repo, ["merge", "-q", "--no-ff", "-m", "m", "feat/pr"])
    await execGit(repo, ["merge", "-q", "--no-ff", "-m", "m2", "feat/other"])
    await execGit(repo, ["update-ref", "refs/remotes/gone/x", await sha(repo, "feat/other")])

    const withPr = await plan(repo, { forge: new FakeForge([openPr(7, "feat/pr")]) })
    expect(entry(withPr, "feat/pr")).toMatchObject({ class: "hold", holdReason: "open-pr", holdDetail: "PR #7" })
    expect(entry(withPr, "feat/other")).toMatchObject({ class: "reclaim" })

    const blind: ForgeClient = {
      pullRequestsForBranch: async () => [],
      pullRequestsForCommit: async () => [],
      ensurePullHeadFetched: async () => {},
    }
    const noCheck = await planBranchGc({ repoRoot: repo, repoName: "fixture", base: "main", forge: blind })
    expect(noCheck.prCheck.available).toBe(false)
    expect(entry(noCheck, "feat/other")).toMatchObject({ class: "hold", holdReason: "pr-check-unavailable" })
    expect(entry(noCheck, "gone/x", "orphan")).toMatchObject({ class: "reclaim" })
  })

  it("summary buckets mirror the reference audit (kind:protected | kind:status)", async () => {
    const repo = await makeRepo()
    await branchWith(repo, "feat/a", { "a.txt": "a\n" })
    await execGit(repo, ["merge", "-q", "--ff-only", "feat/a"])
    await branchWith(repo, "feat/b", { "b.txt": "b\n" })
    const s = summarizeBranchGcPlan(await plan(repo))
    expect(s.byStatus.local).toEqual({ protected: 1, merged: 1, unmerged: 1 })
    expect(s.byClass.local).toEqual({ reclaim: 1, review: 1, hold: 1 })
  })
})

// ── verdicts ─────────────────────────────────────────────────────────────

describe("branch gc — verdict store", () => {
  function verdictFor(name: string, tip: string, agree: boolean, evidence: string[] = ["abc123: base has it"]) {
    return {
      name,
      sha: tip,
      reviewer: "test",
      triage: { verdict: "obsolete", confidence: 0.9, reason: "dead experiment" },
      gate: { agree, verdict: "obsolete", reason: "nothing unique", evidence },
    }
  }

  it("rejects agree:true with empty evidence, and a sha that is not a commit here", async () => {
    const repo = await makeRepo()
    const tip = await branchWith(repo, "feat/x", { "x.txt": "x\n" })
    const store = new InMemoryBranchVerdictStore()
    await expect(recordBranchVerdict({ repoRoot: repo, repoName: "fixture", store, verdict: verdictFor("feat/x", tip, true, []) })).rejects.toThrow(
      BranchVerdictError,
    )
    await expect(
      recordBranchVerdict({ repoRoot: repo, repoName: "fixture", store, verdict: verdictFor("feat/x", "a".repeat(40), false) }),
    ).rejects.toThrow(/not a commit/)
    await expect(
      recordBranchVerdict({ repoRoot: repo, repoName: "fixture", store, verdict: { ...verdictFor("feat/x", tip, false), triage: { verdict: "maybe" } } }),
    ).rejects.toThrow(/triage/)
  })

  it("includeReviewed promotes a review ref only for the SAME tip sha", async () => {
    const repo = await makeRepo()
    const tip = await branchWith(repo, "feat/reviewed", { "r.txt": "r\n" })
    const store = new InMemoryBranchVerdictStore()
    await recordBranchVerdict({ repoRoot: repo, repoName: "fixture", store, verdict: verdictFor("feat/reviewed", tip, true) })

    expect(entry(await plan(repo, { verdicts: store }), "feat/reviewed")).toMatchObject({ class: "review", verdict: { agree: true } })
    expect(entry(await plan(repo, { verdicts: store, includeReviewed: true }), "feat/reviewed")).toMatchObject({
      class: "reclaim",
      reclaimReason: "reviewed",
    })

    // The tip moves: the verdict no longer applies.
    await execGit(repo, ["checkout", "-q", "feat/reviewed"])
    await commitFiles(repo, { "r2.txt": "more\n" }, "more work")
    await execGit(repo, ["checkout", "-q", "main"])
    const moved = entry(await plan(repo, { verdicts: store, includeReviewed: true }), "feat/reviewed")
    expect(moved.class).toBe("review")
    expect(moved.verdict).toBeUndefined()
  })

  it("review queue: one candidate per unique tip, already-reviewed tips skipped unless all", async () => {
    const repo = await makeRepo()
    await withOrigin(repo)
    const tip = await branchWith(repo, "feat/q", { "q.txt": "q\n" })
    await execGit(repo, ["push", "-q", "origin", "feat/q"])
    await execGit(repo, ["fetch", "-q", "origin"])
    const store = new InMemoryBranchVerdictStore()
    const p = await plan(repo, { base: "origin/main", verdicts: store })
    const q = branchReviewQueue(p)
    expect(q.baseSha).toBe(p.baseSha)
    expect(q.candidates).toHaveLength(1)
    expect(q.candidates[0]).toMatchObject({ sha: tip, base: p.baseSha, coverage: { unique: 1 }, residualFiles: ["q.txt"] })
    expect(q.candidates[0]?.refs.sort()).toEqual(["refs/heads/feat/q", "refs/remotes/origin/feat/q"])

    await recordBranchVerdict({ repoRoot: repo, repoName: "fixture", store, verdict: verdictFor("feat/q", tip, false) })
    const p2 = await plan(repo, { base: "origin/main", verdicts: store })
    expect(branchReviewQueue(p2).candidates).toHaveLength(0)
    expect(branchReviewQueue(p2, { all: true }).candidates).toHaveLength(1)
  })
})

// ── apply ────────────────────────────────────────────────────────────────

describe("branch gc — apply", () => {
  it("requires explicit scopes", async () => {
    const repo = await makeRepo()
    const p = await plan(repo)
    await expect(applyBranchGc(p, { scopes: [] })).rejects.toThrow(/scopes/)
  })

  it("refuses a stale plan: a moved tip and a newly worktree-held branch are not deleted", async () => {
    const repo = await makeRepo()
    await branchWith(repo, "feat/moves", { "a.txt": "a\n" })
    await branchWith(repo, "feat/gets-worktree", { "b.txt": "b\n" })
    await execGit(repo, ["merge", "-q", "--no-ff", "-m", "m", "feat/moves"])
    await execGit(repo, ["merge", "-q", "--no-ff", "-m", "m2", "feat/gets-worktree"])
    const p = await plan(repo)
    expect(entry(p, "feat/moves").class).toBe("reclaim")
    expect(entry(p, "feat/gets-worktree").class).toBe("reclaim")

    await execGit(repo, ["checkout", "-q", "feat/moves"])
    await commitFiles(repo, { "new.txt": "new work after the plan\n" }, "new work")
    await execGit(repo, ["checkout", "-q", "main"])
    const wtPath = join(await tmp("branch-gc-wt-"), "late")
    await execGit(repo, ["worktree", "add", "-q", wtPath, "feat/gets-worktree"])

    const stateDir = await tmp("branch-gc-state-")
    const { outcomes, restoreLog } = await applyBranchGc(p, { scopes: ["local"], forge: new FakeForge(), stateDir })
    expect(outcomes.find((o) => o.name === "feat/moves")).toMatchObject({ result: "aborted-moved" })
    expect(outcomes.find((o) => o.name === "feat/gets-worktree")).toMatchObject({
      result: "aborted-reclassified",
      from: "reclaim",
      to: "hold",
      holdReason: "worktree",
    })
    expect(outcomes.find((o) => o.name === "main")).toMatchObject({ result: "held" })
    expect(restoreLog).toBeNull()
    expect(await refExists(repo, "refs/heads/feat/moves")).toBe(true)
    expect(await refExists(repo, "refs/heads/feat/gets-worktree")).toBe(true)
  })

  it("never advertises or deletes a branch checked out in any linked worktree — merged, prunable, or reviewed-and-agreed", async () => {
    const repo = await makeRepo()
    const pool = await tmp("branch-gc-wt-")
    // Merged into base: the ladder alone would say reclaim.
    await branchWith(repo, "wt/merged-live", { "a.txt": "a\n" })
    await execGit(repo, ["merge", "-q", "--no-ff", "-m", "m", "wt/merged-live"])
    await execGit(repo, ["worktree", "add", "-q", join(pool, "live"), "wt/merged-live"])
    // Merged, and its worktree directory is gone (git marks it prunable) —
    // git still counts the branch as checked out until the entry is pruned.
    await branchWith(repo, "wt/merged-prunable", { "b.txt": "b\n" })
    await execGit(repo, ["merge", "-q", "--no-ff", "-m", "m2", "wt/merged-prunable"])
    await execGit(repo, ["worktree", "add", "-q", join(pool, "gone"), "wt/merged-prunable"])
    await rm(join(pool, "gone"), { recursive: true, force: true })
    // Unmerged with an agreeing verdict — includeReviewed would reclaim it.
    const tip = await branchWith(repo, "wt/reviewed-live", { "c.txt": "c\n" })
    await execGit(repo, ["worktree", "add", "-q", join(pool, "reviewed"), "wt/reviewed-live"])
    const verdicts = new InMemoryBranchVerdictStore()
    await recordBranchVerdict({
      repoRoot: repo,
      repoName: "fixture",
      store: verdicts,
      verdict: {
        name: "wt/reviewed-live",
        sha: tip,
        reviewer: "test",
        triage: { verdict: "obsolete", confidence: 1, reason: "dead" },
        gate: { agree: true, verdict: "obsolete", reason: "nothing unique", evidence: ["c.txt: throwaway"] },
      },
    })

    const p = await plan(repo, { includeReviewed: true, verdicts })
    for (const name of ["wt/merged-live", "wt/merged-prunable", "wt/reviewed-live"]) {
      expect(entry(p, name)).toMatchObject({ class: "hold", holdReason: "worktree" })
    }
    expect(summarizeBranchGcPlan(p).byClass.local.reclaim).toBe(0)

    const stateDir = await tmp("branch-gc-state-")
    const { outcomes } = await applyBranchGc(p, { scopes: ["local"], forge: new FakeForge(), verdicts, stateDir })
    for (const name of ["wt/merged-live", "wt/merged-prunable", "wt/reviewed-live"]) {
      expect(outcomes.find((o) => o.name === name)).toMatchObject({ result: "held", holdReason: "worktree" })
      expect(await refExists(repo, `refs/heads/${name}`)).toBe(true)
    }
  })

  it("never touches review or hold, and leaves kinds outside scopes alone", async () => {
    const repo = await makeRepo()
    await branchWith(repo, "feat/unmerged", { "u.txt": "u\n" })
    await branchWith(repo, "feat/merged", { "m.txt": "m\n" })
    await execGit(repo, ["merge", "-q", "--ff-only", "feat/merged"])
    await execGit(repo, ["update-ref", "refs/remotes/gone/merged", await sha(repo, "main")])
    const p = await plan(repo)
    const stateDir = await tmp("branch-gc-state-")
    const { outcomes } = await applyBranchGc(p, { scopes: ["local"], forge: new FakeForge(), stateDir })
    expect(outcomes.find((o) => o.name === "feat/unmerged")).toMatchObject({ result: "skipped-review" })
    expect(outcomes.find((o) => o.name === "feat/merged")).toMatchObject({ result: "deleted", reclaimReason: "merged" })
    expect(outcomes.some((o) => o.kind === "orphan")).toBe(false)
    expect(await refExists(repo, "refs/heads/feat/unmerged")).toBe(true)
    expect(await refExists(repo, "refs/remotes/gone/merged")).toBe(true)
  })

  it("restore log round-trip: local, remote and orphan deletions re-create at the same sha", async () => {
    const repo = await makeRepo()
    const bare = await withOrigin(repo)
    await branchWith(repo, "feat/done", { "d.txt": "d\n" })
    await branchWith(repo, "feat/remote-done", { "r.txt": "r\n" })
    await execGit(repo, ["merge", "-q", "--no-ff", "-m", "m", "feat/done"])
    await execGit(repo, ["merge", "-q", "--no-ff", "-m", "m2", "feat/remote-done"])
    await execGit(repo, ["push", "-q", "origin", "main", "feat/remote-done"])
    await execGit(repo, ["fetch", "-q", "origin"])
    await execGit(repo, ["branch", "-q", "-D", "feat/remote-done"]) // remote-only now
    const orphanSha = await sha(repo, "feat/done")
    await execGit(repo, ["update-ref", "refs/remotes/gone/done", orphanSha])
    const before = {
      local: await sha(repo, "refs/heads/feat/done"),
      remote: await sha(repo, "refs/remotes/origin/feat/remote-done"),
      orphan: orphanSha,
    }

    const p = await plan(repo, { base: "origin/main" })
    const stateDir = await tmp("branch-gc-state-")
    const { outcomes, restoreLog } = await applyBranchGc(p, { scopes: ["local", "remote", "orphan"], forge: new FakeForge(), stateDir })
    expect(outcomes.filter((o) => o.result === "deleted").map((o) => `${o.kind}:${o.name}`).sort()).toEqual([
      "local:feat/done",
      "orphan:gone/done",
      "remote:feat/remote-done",
    ])
    expect(await refExists(repo, "refs/heads/feat/done")).toBe(false)
    expect(await refExists(repo, "refs/remotes/origin/feat/remote-done")).toBe(false)
    expect(await refExists(bare, "refs/heads/feat/remote-done")).toBe(false)
    expect(await refExists(repo, "refs/remotes/gone/done")).toBe(false)

    expect(restoreLog).toBeTruthy()
    expect(restoreLog?.startsWith(join(stateDir, "fixture"))).toBe(true)
    const log = await readBranchGcRestoreLog(restoreLog as string)
    expect(log.entries).toHaveLength(3)
    expect(log.entries.every((e) => e.deleted === true)).toBe(true)
    for (const e of log.entries) {
      expect(e.command).toContain(e.sha)
      await execGit(repo, e.argv)
    }
    await execGit(repo, ["fetch", "-q", "origin"])
    expect(await sha(repo, "refs/heads/feat/done")).toBe(before.local)
    expect(await sha(repo, "refs/remotes/origin/feat/remote-done")).toBe(before.remote)
    expect(await sha(repo, "refs/remotes/gone/done")).toBe(before.orphan)
  })

  it("a remote ref already gone upstream still counts as deleted (non-atomic push batch)", async () => {
    const repo = await makeRepo()
    const bare = await withOrigin(repo)
    await branchWith(repo, "feat/one", { "1.txt": "1\n" })
    await branchWith(repo, "feat/two", { "2.txt": "2\n" })
    await execGit(repo, ["merge", "-q", "--no-ff", "-m", "m", "feat/one"])
    await execGit(repo, ["merge", "-q", "--no-ff", "-m", "m2", "feat/two"])
    await execGit(repo, ["push", "-q", "origin", "main", "feat/one", "feat/two"])
    await execGit(repo, ["fetch", "-q", "origin"])
    await execGit(repo, ["branch", "-q", "-D", "feat/one", "feat/two"])
    const p = await plan(repo, { base: "origin/main" })
    // Someone deletes feat/one upstream between plan and apply; our tracking ref is stale.
    await execGit(bare, ["update-ref", "-d", "refs/heads/feat/one"])
    const { outcomes } = await applyBranchGc(p, { scopes: ["remote"], forge: new FakeForge(), stateDir: await tmp("branch-gc-state-") })
    expect(outcomes.filter((o) => o.result === "deleted").map((o) => o.name).sort()).toEqual(["feat/one", "feat/two"])
    expect(await refExists(bare, "refs/heads/feat/two")).toBe(false)
  })
})

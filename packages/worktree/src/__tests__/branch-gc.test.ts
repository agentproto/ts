/**
 * `branch gc` tests. Every tier is driven against a real disposable git repo
 * (plus a bare repo standing in for `origin` where remote refs matter) — the
 * same posture as `gc.test.ts`: a mocked git proves nothing about the ladder.
 * The forge is always a test double.
 */
import { describe, it, expect, afterEach, vi } from "vitest"
import { mkdtemp, rm, writeFile, mkdir, realpath, chmod, stat, utimes } from "node:fs/promises"
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
  approveBranchVerdict,
  classifyTip,
  createLadderContext,
  InMemoryBranchVerdictStore,
  FileBranchVerdictStore,
  BranchVerdictError,
  CHECKPOINT_BRANCH_PREFIX,
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
  constructor(
    private readonly open: ForgePullRequestRef[] = [],
    private readonly merged: ForgePullRequestRef[] = [],
  ) {}
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
  async listMergedPullRequests(): Promise<ForgePullRequestRef[]> {
    return this.merged
  }
}

function openPr(number: number, headRefName: string): ForgePullRequestRef {
  return { number, state: "open", merged: false, mergedAt: null, headRefName, headRefOid: "0".repeat(40) }
}

function mergedPr(number: number, headRefName: string, headRefOid: string): ForgePullRequestRef {
  return { number, state: "closed", merged: true, mergedAt: "2026-01-01T00:00:00Z", headRefName, headRefOid }
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

  it("patch-merged needs EVERY commit picked: one cherry-picked + one unpicked commit stays unmerged", async () => {
    const repo = await makeRepo()
    await commitFiles(repo, { "conf.txt": "line1\nvalue=1\nline3\n" }, "conf")
    const first = await branchWith(repo, "feat/half", { "conf.txt": "line1\nvalue=2\nline3\n" })
    await execGit(repo, ["checkout", "-q", "feat/half"])
    await commitFiles(repo, { "extra.txt": "never landed\n" }, "second commit, not picked")
    await execGit(repo, ["checkout", "-q", "main"])
    await commitFiles(repo, { "other.txt": "o\n" }, "unrelated base work")
    await execGit(repo, ["cherry-pick", first])
    await commitFiles(repo, { "conf.txt": "line1\nvalue=3\nline3\n" }, "base keeps editing")
    const e = entry(await plan(repo), "feat/half")
    expect(e).toMatchObject({ status: "unmerged", conflicts: true })
    expect(e.class).not.toBe("reclaim")
  })

  it("ladder context patch-ids: equal for a cherry-pick, distinct otherwise, null for an empty commit, memoized", async () => {
    const repo = await makeRepo()
    const tip = await branchWith(repo, "feat/p", { "p.txt": "p\n" })
    await commitFiles(repo, { "other.txt": "o\n" }, "unrelated base work")
    await execGit(repo, ["cherry-pick", tip])
    const picked = await sha(repo, "HEAD")
    const unrelated = await sha(repo, "HEAD~1")
    const empty = await commitFiles(repo, {}, "empty commit")
    const ctx = await createLadderContext(repo, "main", null)
    const ids = await ctx.patchIds!([tip, picked, unrelated, empty])
    expect(ids).not.toBeNull()
    expect(ids!.get(tip)).toMatch(/^[0-9a-f]{40}$/)
    expect(ids!.get(picked)).toBe(ids!.get(tip))
    expect(ids!.get(unrelated)).not.toBe(ids!.get(tip))
    expect(ids!.get(empty)).toBeNull()
    // `git patch-id` itself is the reference.
    const ref = (await execArgv("sh", ["-c", `git -C '${repo}' show ${tip} | git patch-id --stable`], repo)).stdout.split(" ")[0]
    expect(ids!.get(tip)).toBe(ref)
    // A second ask is served from the cache (same answer, no recompute needed).
    expect(await ctx.patchIds!([tip])).toEqual(new Map([[tip, ids!.get(tip)]]))
  })

  it("a known merge-base from the anchor sweep gives the same classification as asking git", async () => {
    const repo = await makeRepo()
    const base = await sha(repo, "main")
    const tip = await branchWith(repo, "feat/mb", { "mb.txt": "mb\n" })
    await commitFiles(repo, { "later.txt": "l\n" }, "base moves on")
    const plain = await createLadderContext(repo, "main", null)
    const known = await createLadderContext(repo, "main", null, new Map([[tip, true]]), new Map([[tip, base]]))
    const want = await classifyTip(plain, tip)
    expect(want).toMatchObject({ status: "unmerged", mergeBase: base })
    expect(await classifyTip(known, tip)).toEqual(want)
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

// ── merged-PR head shortcut ──────────────────────────────────────────────

describe("branch gc — pr-merged shortcut", () => {
  it("an unmerged tip that IS a merged PR's head commit reclaims without a review", async () => {
    const repo = await makeRepo()
    const tip = await branchWith(repo, "feat/squash-merged-on-github", { "a.txt": "a\n" })
    await commitFiles(repo, { "later.txt": "x\n" }, "later work") // base moved on after the squash merge
    const p = await plan(repo, { forge: new FakeForge([], [mergedPr(101, "feat/squash-merged-on-github", tip)]) })
    expect(entry(p, "feat/squash-merged-on-github")).toMatchObject({
      status: "pr-merged",
      mergedPr: 101,
      class: "reclaim",
      reclaimReason: "pr-merged",
    })
    // No forge shortcut data → the same branch stays review.
    const without = await plan(repo, { forge: new FakeForge() })
    expect(entry(without, "feat/squash-merged-on-github")).toMatchObject({ status: "unmerged", class: "review" })
  })

  it("a commit AFTER the merged head defeats the shortcut — the branch still needs review", async () => {
    const repo = await makeRepo()
    const head = await branchWith(repo, "feat/grew-after-merge", { "a.txt": "a\n" })
    await commitFiles(repo, { "later.txt": "x\n" }, "later work")
    // The branch tip moved past the merged head: the new work was never reviewed.
    await execGit(repo, ["checkout", "-q", "feat/grew-after-merge"])
    await commitFiles(repo, { "unreviewed.txt": "unreviewed\n" }, "post-merge work")
    await execGit(repo, ["checkout", "-q", "main"])
    const p = await plan(repo, { forge: new FakeForge([], [mergedPr(102, "feat/grew-after-merge", head)]) })
    expect(entry(p, "feat/grew-after-merge")).toMatchObject({ status: "unmerged", class: "review" })
  })

  it("a forge without listMergedPullRequests behaves exactly as before (review, no shortcut)", async () => {
    const repo = await makeRepo()
    await branchWith(repo, "feat/no-shortcut", { "a.txt": "a\n" })
    await commitFiles(repo, { "later.txt": "x\n" }, "later work")
    // An old-style client: open-PR detection works, merged-PR listing doesn't
    // (the optional method exists so such doubles keep compiling).
    const legacy: ForgeClient = {
      pullRequestsForBranch: async () => [],
      pullRequestsForCommit: async () => [],
      ensurePullHeadFetched: async () => {},
      listOpenPullRequests: async () => [],
    }
    const p = await plan(repo, { forge: legacy })
    expect(p.prCheck.available).toBe(true)
    expect(entry(p, "feat/no-shortcut")).toMatchObject({ status: "unmerged", class: "review" })
  })

  it("holds still win over the pr-merged shortcut, and the deleted verdict-branch keeps the shortcut", async () => {
    const repo = await makeRepo()
    const tip = await branchWith(repo, "feat/merged-then-protected", { "a.txt": "a\n" })
    await commitFiles(repo, { "later.txt": "x\n" }, "later work")
    const forge = new FakeForge([openPr(9, "feat/merged-then-protected")], [mergedPr(103, "feat/merged-then-protected", tip)])
    // tip is BOTH an open PR head and a merged PR head: the open-PR hold wins.
    const held = await plan(repo, { forge })
    expect(entry(held, "feat/merged-then-protected")).toMatchObject({ class: "hold", holdReason: "open-pr", holdDetail: "PR #9" })
    // With the open PR gone, the shortcut alone decides — base moved on, so
    // the ladder alone would never have said reclaim.
    const now = await plan(repo, { forge: new FakeForge([], [mergedPr(103, "feat/merged-then-protected", tip)]) })
    expect(entry(now, "feat/merged-then-protected")).toMatchObject({ status: "pr-merged", class: "reclaim" })
  })

  it("pr-merged is deletable: apply re-classifies from scratch and keeps the shortcut", async () => {
    const repo = await makeRepo()
    const tip = await branchWith(repo, "feat/apply-me", { "a.txt": "a\n" })
    await commitFiles(repo, { "later.txt": "x\n" }, "later work")
    const forge = new FakeForge([], [mergedPr(104, "feat/apply-me", tip)])
    const p = await plan(repo, { forge })
    expect(entry(p, "feat/apply-me").class).toBe("reclaim")
    const stateDir = await tmp("branch-gc-state-")
    const { outcomes, restoreLog } = await applyBranchGc(p, { scopes: ["local"], forge, stateDir })
    expect(outcomes.find((o) => o.name === "feat/apply-me")).toMatchObject({ result: "deleted", reclaimReason: "pr-merged" })
    expect(await refExists(repo, "refs/heads/feat/apply-me")).toBe(false)
    expect(restoreLog).toBeTruthy()
  })
})

// ── merged-PR history: ancestor + patch-equivalent matches ──────────────

/** Build a PR head on a throwaway branch, then delete the branch: like a merged PR whose head ref is gone but whose commits were fetched. */
async function prHeadVia(repo: string, from: string, build: () => Promise<void>): Promise<string> {
  await execGit(repo, ["checkout", "-q", "-b", "tmp/pr-head", from])
  await build()
  const head = await sha(repo, "HEAD")
  await execGit(repo, ["checkout", "-q", "main"])
  await execGit(repo, ["branch", "-q", "-D", "tmp/pr-head"])
  return head
}

describe("branch gc — pr-merged through a merged PR's history", () => {
  it("ancestor: the tip is an ancestor of a merged PR's head (the PR kept going after the branch stopped)", async () => {
    const repo = await makeRepo()
    const tip = await branchWith(repo, "feat/stopped-early", { "a.txt": "a\n" })
    const head = await prHeadVia(repo, tip, async () => {
      await commitFiles(repo, { "b.txt": "b\n" }, "more work on the PR")
    })
    await commitFiles(repo, { "later.txt": "x\n" }, "later work") // base moved on after the squash merge
    const forge = new FakeForge([], [mergedPr(201, "feat/kept-going", head)])
    const p = await plan(repo, { forge })
    expect(entry(p, "feat/stopped-early")).toMatchObject({
      status: "pr-merged",
      mergedPr: 201,
      mergedPrMatch: "ancestor",
      class: "reclaim",
      reclaimReason: "pr-merged",
    })
    // No forge data → the same branch stays review.
    expect(entry(await plan(repo), "feat/stopped-early")).toMatchObject({ status: "unmerged", class: "review" })
    // apply re-classifies from scratch and keeps the match.
    const stateDir = await tmp("branch-gc-state-")
    const { outcomes } = await applyBranchGc(p, { scopes: ["local"], forge, stateDir })
    expect(outcomes.find((o) => o.name === "feat/stopped-early")).toMatchObject({ result: "deleted", reclaimReason: "pr-merged" })
    expect(await refExists(repo, "refs/heads/feat/stopped-early")).toBe(false)
  })

  it("the exact-head match reports mergedPrMatch head", async () => {
    const repo = await makeRepo()
    const tip = await branchWith(repo, "feat/exact", { "a.txt": "a\n" })
    await commitFiles(repo, { "later.txt": "x\n" }, "later work")
    const p = await plan(repo, { forge: new FakeForge([], [mergedPr(202, "feat/exact", tip)]) })
    expect(entry(p, "feat/exact")).toMatchObject({ status: "pr-merged", mergedPr: 202, mergedPrMatch: "head", class: "reclaim" })
  })

  it("patch: a rebased branch whose every commit is patch-equivalent to a merged PR's commits", async () => {
    const repo = await makeRepo()
    await branchWith(repo, "fix/rebased-away", { "a.txt": "a\n" })
    await execGit(repo, ["checkout", "-q", "fix/rebased-away"])
    const tip = await commitFiles(repo, { "b.txt": "b\n" }, "second fix")
    await execGit(repo, ["checkout", "-q", "main"])
    await commitFiles(repo, { "other.txt": "o\n" }, "unrelated base work")
    // The PR was rebased onto the new base (new shas, same patches), then got a review fix.
    const head = await prHeadVia(repo, "main", async () => {
      await execGit(repo, ["cherry-pick", "main..fix/rebased-away"])
      await commitFiles(repo, { "c.txt": "c\n" }, "review fix")
    })
    await commitFiles(repo, { "later.txt": "x\n" }, "later work")
    expect(await execArgv("git", ["-C", repo, "merge-base", "--is-ancestor", tip, head], repo)).toMatchObject({ exitCode: 1 })
    const p = await plan(repo, { forge: new FakeForge([], [mergedPr(203, "fix/rebased-away", head)]) })
    expect(entry(p, "fix/rebased-away")).toMatchObject({
      status: "pr-merged",
      mergedPr: 203,
      mergedPrMatch: "patch",
      class: "reclaim",
      reclaimReason: "pr-merged",
    })
    expect(entry(await plan(repo), "fix/rebased-away")).toMatchObject({ status: "unmerged", class: "review" })
  })

  it("patch: the tip's commits landed split across two merged PRs (a stacked branch)", async () => {
    const repo = await makeRepo()
    await branchWith(repo, "feat/stacked", { "a.txt": "a\n" })
    await execGit(repo, ["checkout", "-q", "feat/stacked"])
    const first = await sha(repo, "HEAD")
    await commitFiles(repo, { "b.txt": "b\n" }, "second change")
    await execGit(repo, ["checkout", "-q", "main"])
    await commitFiles(repo, { "other.txt": "o\n" }, "unrelated base work")
    const headA = await prHeadVia(repo, "main", async () => {
      await execGit(repo, ["cherry-pick", first])
    })
    const headB = await prHeadVia(repo, "main", async () => {
      await execGit(repo, ["cherry-pick", "feat/stacked"])
    })
    await commitFiles(repo, { "later.txt": "x\n" }, "later work")
    // Either PR alone leaves one commit unmatched.
    const onlyB = await plan(repo, { forge: new FakeForge([], [mergedPr(205, "feat/stacked", headB)]) })
    expect(entry(onlyB, "feat/stacked")).toMatchObject({ status: "unmerged", class: "review" })
    const both = await plan(repo, { forge: new FakeForge([], [mergedPr(204, "feat/stacked-base", headA), mergedPr(205, "feat/stacked", headB)]) })
    expect(entry(both, "feat/stacked")).toMatchObject({ status: "pr-merged", mergedPrMatch: "patch", class: "reclaim" })
    expect([204, 205]).toContain(entry(both, "feat/stacked").mergedPr)
  })

  it("patch: one tip commit with no patch-equivalent in any merged PR keeps the branch in review", async () => {
    const repo = await makeRepo()
    await branchWith(repo, "fix/one-extra", { "a.txt": "a\n" })
    await execGit(repo, ["checkout", "-q", "fix/one-extra"])
    const landed = await sha(repo, "HEAD")
    await commitFiles(repo, { "extra.txt": "never in a PR\n" }, "unique follow-up")
    await execGit(repo, ["checkout", "-q", "main"])
    await commitFiles(repo, { "other.txt": "o\n" }, "unrelated base work")
    const head = await prHeadVia(repo, "main", async () => {
      await execGit(repo, ["cherry-pick", landed])
    })
    await commitFiles(repo, { "later.txt": "x\n" }, "later work")
    const p = await plan(repo, { forge: new FakeForge([], [mergedPr(206, "fix/one-extra", head)]) })
    expect(entry(p, "fix/one-extra")).toMatchObject({ status: "unmerged", class: "review" })
    expect(entry(p, "fix/one-extra").mergedPr).toBeUndefined()
  })

  it("patch: same author and time but a different diff is no match", async () => {
    const repo = await makeRepo()
    const tip = await branchWith(repo, "fix/amended", { "a.txt": "a\n" })
    await commitFiles(repo, { "other.txt": "o\n" }, "unrelated base work")
    // The PR's commit keeps the tip's author key (cherry-pick, then amend) but changes its content.
    const head = await prHeadVia(repo, "main", async () => {
      await execGit(repo, ["cherry-pick", tip])
      await writeFile(join(repo, "a.txt"), "a, but different\n")
      await execGit(repo, ["add", "a.txt"])
      await execGit(repo, ["commit", "-q", "--amend", "--no-edit"])
    })
    await commitFiles(repo, { "later.txt": "x\n" }, "later work")
    const p = await plan(repo, { forge: new FakeForge([], [mergedPr(207, "fix/amended", head)]) })
    expect(entry(p, "fix/amended")).toMatchObject({ status: "unmerged", class: "review" })
  })

  it("patch: a merge commit carrying its own resolution keeps the branch in review even when every non-merge commit matches", async () => {
    const repo = await makeRepo()
    const own = await branchWith(repo, "feat/evil-merge", { "a.txt": "a\n" })
    const side = await branchWith(repo, "side/merged-in", { "b.txt": "b\n" })
    await execGit(repo, ["checkout", "-q", "feat/evil-merge"])
    await execGit(repo, ["merge", "-q", "--no-ff", "--no-commit", "side/merged-in"])
    await writeFile(join(repo, "resolution.txt"), "only in the merge commit\n")
    await execGit(repo, ["add", "resolution.txt"])
    await execGit(repo, ["commit", "-q", "--no-edit"])
    await execGit(repo, ["checkout", "-q", "main"])
    await execGit(repo, ["branch", "-q", "-D", "side/merged-in"])
    await commitFiles(repo, { "other.txt": "o\n" }, "unrelated base work")
    // Both non-merge commits landed through a PR; the merge's resolution.txt never did.
    const head = await prHeadVia(repo, "main", async () => {
      await execGit(repo, ["cherry-pick", own, side])
    })
    await commitFiles(repo, { "later.txt": "x\n" }, "later work")
    const p = await plan(repo, { forge: new FakeForge([], [mergedPr(209, "feat/evil-merge", head)]) })
    expect(entry(p, "feat/evil-merge")).toMatchObject({ status: "unmerged", class: "review" })
  })

  it("a merged PR head missing from the object database offers no match (the plan never fetches)", async () => {
    const repo = await makeRepo()
    await branchWith(repo, "feat/unknown-head", { "a.txt": "a\n" })
    await commitFiles(repo, { "later.txt": "x\n" }, "later work")
    const p = await plan(repo, { forge: new FakeForge([], [mergedPr(208, "feat/unknown-head", "1".repeat(40))]) })
    expect(entry(p, "feat/unknown-head")).toMatchObject({ status: "unmerged", class: "review" })
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

  it("a tip unrelated to both base and the anchor (a ref from another repo) is unmerged/unrelated, not a diff of an empty merge-base", async () => {
    const repo = await makeRepo("old")
    await branchWith(repo, "feat/pre-unique", { "u.txt": "u\n" }, "old", "old")
    const anchor = await commitFiles(repo, { "s.txt": "s\n" }, "old tip")
    await execGit(repo, ["checkout", "-q", "--orphan", "main"])
    await execGit(repo, ["commit", "-q", "-m", "snapshot"])
    await commitFiles(repo, { "new.txt": "new\n" }, "post-rewrite work")
    // A third, independent root — e.g. `refs/remotes/<other-repo>/main`.
    await execGit(repo, ["checkout", "-q", "--orphan", "foreign"])
    await execGit(repo, ["rm", "-rq", "--cached", "."])
    const foreign = await commitFiles(repo, { "f.txt": "f\n" }, "foreign root")
    await execGit(repo, ["checkout", "-q", "-f", "main"])

    const p = await plan(repo, { scopes: ["local"] })
    expect(p.anchor).toBe(anchor)
    expect(entry(p, "foreign")).toMatchObject({ status: "unmerged", history: "unrelated" })
    expect(entry(p, "feat/pre-unique")).toMatchObject({ status: "unmerged", history: "pre-rewrite", compareBase: anchor })
    const ctx = await createLadderContext(repo, "main", anchor)
    expect(await classifyTip(ctx, foreign)).toMatchObject({ status: "unmerged", history: "unrelated", conflicts: true, ahead: null })
  })

  it("without history in common and no anchor, a tip is unmerged/unrelated", async () => {
    const repo = await makeRepo()
    await execGit(repo, ["checkout", "-q", "--orphan", "island"])
    const island = await commitFiles(repo, { "i.txt": "i\n" }, "island")
    await execGit(repo, ["checkout", "-q", "main"])
    const ctx = await createLadderContext(repo, "main", null)
    expect(await classifyTip(ctx, island)).toMatchObject({ status: "unmerged", history: "unrelated", ahead: null })
  })

  it("the ladder trusts a known shared-history answer (the plan's anchor sweep) instead of re-asking git", async () => {
    const repo = await makeRepo()
    const tip = await branchWith(repo, "feat/x", { "x.txt": "x\n" })
    // Deliberately wrong answer: proves the map, not `git merge-base`, decided.
    const ctx = await createLadderContext(repo, "main", null, new Map([[tip, false]]))
    expect(await classifyTip(ctx, tip)).toMatchObject({ status: "unmerged", history: "unrelated", ahead: null })
    // Without the map, git answers: it shares history.
    const plain = await createLadderContext(repo, "main", null)
    expect(await classifyTip(plain, tip)).toMatchObject({ history: "current" })
  })
})

// ── ref kinds + holds ───────────────────────────────────────────────────

async function withOrigin(repo: string): Promise<string> {
  const bare = await tmp("branch-gc-origin-")
  await execGit(bare, ["init", "-q", "--bare", "-b", "main"])
  // `receive-pack` runs with the pusher's GIT_CONFIG_* env stripped, so the
  // vitest.setup.ts override can't reach it; disable auto-maintenance per repo.
  await execGit(bare, ["config", "maintenance.auto", "false"])
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

  it("a local branch whose tip is an ancestor of a remote ref (not equal to any remote tip) is contained-in-remote", async () => {
    const repo = await makeRepo()
    await withOrigin(repo)
    const work = await branchWith(repo, "feat/work", { "a.txt": "a\n" })
    // Push a branch that is one commit AHEAD of feat/work: its remote tip
    // differs from `work`, but `work`'s tip is reachable from it.
    await branchWith(repo, "feat/ahead", { "b.txt": "b\n" }, "feat/work")
    await execGit(repo, ["push", "-q", "origin", "feat/ahead"])
    await execGit(repo, ["branch", "-q", "-D", "feat/ahead"])
    await execGit(repo, ["fetch", "-q", "origin"])
    expect(work).not.toBe(await sha(repo, "main"))
    const e = entry(await plan(repo), "feat/work")
    expect(e).toMatchObject({ status: "unmerged", class: "review", pushed: "contained-in-remote" })
  })
  
  it("plan prunes stale remote-tracking refs: a branch deleted upstream is not classified", async () => {
    const repo = await makeRepo()
    const bare = await withOrigin(repo)
    await branchWith(repo, "gone", { "g.txt": "g\n" })
    await execGit(repo, ["push", "-q", "origin", "gone"])
    await execGit(repo, ["fetch", "-q", "origin"])
    expect(await refExists(repo, "refs/remotes/origin/gone")).toBe(true)
    // Delete directly in the bare repo — the tracking ref is now a ghost.
    await execGit(bare, ["update-ref", "-d", "refs/heads/gone"])

    const p = await plan(repo, { base: "origin/main" })
    expect(p.fetched).toBe(true)
    expect(p.entries.some((e) => e.ref === "refs/remotes/origin/gone")).toBe(false)
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

  it("summary counts distinct branch names next to the per-kind ref counts", () => {
    const e = (kind: BranchGcPlanEntry["kind"], name: string, cls: BranchGcPlanEntry["class"], status: BranchGcPlanEntry["status"]) =>
      ({ kind, name, class: cls, status }) as BranchGcPlanEntry
    // `feat/a` and `feat/b` each have a local and a remote ref: 5 refs, 3 branches.
    const p = {
      entries: [
        e("local", "feat/a", "review", "unmerged"),
        e("remote", "feat/a", "review", "unmerged"),
        e("local", "feat/b", "review", "unmerged"),
        e("remote", "feat/b", "reclaim", "merged"),
        e("local", "feat/c", "review", "unmerged"),
      ],
    } as BranchGcPlan
    const s = summarizeBranchGcPlan(p)
    expect(s.byStatus.local.unmerged! + s.byStatus.remote.unmerged!).toBe(4)
    expect(s.distinct).toEqual({
      branches: 3,
      refs: 5,
      byClass: { reclaim: 1, review: 3, hold: 0 },
      byStatus: { unmerged: 3, merged: 1 },
    })
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
    // The operator override is a separate trust boundary: a reviewer cannot self-certify.
    await expect(
      recordBranchVerdict({
        repoRoot: repo,
        repoName: "fixture",
        store,
        verdict: { ...verdictFor("feat/x", tip, false), operator: { by: "TEST" } },
      }),
    ).rejects.toThrow(/other than the reviewer/)
    await expect(
      recordBranchVerdict({
        repoRoot: repo,
        repoName: "fixture",
        store,
        verdict: { ...verdictFor("feat/x", tip, false), operator: { by: "   " } },
      }),
    ).rejects.toThrow(/operator\.by/)
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

  it("keeps every verdict when concurrent records race (G8)", async () => {
    const repo = await makeRepo()
    const path = join(await tmp("branch-gc-verdicts-"), "verdicts.json")
    const tips: string[] = []
    for (let i = 0; i < 12; i++) tips.push(await branchWith(repo, `feat/race-${i}`, { [`race-${i}.txt`]: `${i}\n` }))

    // The daemon's recorder builds a fresh store per call; fire all of them at once.
    await Promise.all(
      tips.map((tip, i) =>
        recordBranchVerdict({
          repoRoot: repo,
          repoName: "fixture",
          store: new FileBranchVerdictStore(path),
          verdict: verdictFor(`feat/race-${i}`, tip, false),
        }),
      ),
    )

    const reader = new FileBranchVerdictStore(path)
    for (let i = 0; i < tips.length; i++) {
      expect(await reader.get("fixture", tips[i] as string)).toMatchObject({ name: `feat/race-${i}`, sha: tips[i] })
    }
  })

  it("reaps a stale lock and leaves no lock behind", async () => {
    const repo = await makeRepo()
    const tip = await branchWith(repo, "feat/locked", { "locked.txt": "locked\n" })
    const path = join(await tmp("branch-gc-verdicts-"), "verdicts.json")
    const lockPath = `${path}.lock`
    await writeFile(lockPath, "dead-process:dead-token\n")
    const old = new Date(Date.now() - 120_000)
    await utimes(lockPath, old, old)

    await recordBranchVerdict({
      repoRoot: repo,
      repoName: "fixture",
      store: new FileBranchVerdictStore(path),
      verdict: verdictFor("feat/locked", tip, false),
    })
    await expect(stat(lockPath)).rejects.toThrow()
    expect(await new FileBranchVerdictStore(path).get("fixture", tip)).toMatchObject({ name: "feat/locked" })
  })

  it("a long-lived reader observes a verdict another store wrote (no stale cache)", async () => {
    const repo = await makeRepo()
    const tip = await branchWith(repo, "feat/later", { "later.txt": "later\n" })
    const path = join(await tmp("branch-gc-verdicts-"), "verdicts.json")
    const reader = new FileBranchVerdictStore(path)
    expect(await reader.get("fixture", tip)).toBeNull()

    await recordBranchVerdict({
      repoRoot: repo,
      repoName: "fixture",
      store: new FileBranchVerdictStore(path),
      verdict: verdictFor("feat/later", tip, false),
    })
    expect(await reader.get("fixture", tip)).toMatchObject({ name: "feat/later", sha: tip })
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
    // A failing pre-push hook must not stop the deletion: no-verify skips it.
    const hook = join(repo, ".git", "hooks", "pre-push")
    await mkdir(dirname(hook), { recursive: true })
    await writeFile(hook, "#!/bin/sh\nexit 1\n")
    await chmod(hook, 0o755)
    const { outcomes } = await applyBranchGc(p, { scopes: ["remote"], forge: new FakeForge(), stateDir: await tmp("branch-gc-state-"), fetch: false })
    expect(outcomes.filter((o) => o.result === "deleted").map((o) => o.name).sort()).toEqual(["feat/one", "feat/two"])
    expect(await refExists(bare, "refs/heads/feat/two")).toBe(false)
  })

  it("a refused batch is retried as a batch: ghost + real refs all resolve without per-ref pushes", async () => {
    const repo = await makeRepo()
    const bare = await withOrigin(repo)
    await branchWith(repo, "feat/a", { "a.txt": "a\n" })
    await branchWith(repo, "feat/b", { "b.txt": "b\n" })
    await execGit(repo, ["merge", "-q", "--no-ff", "-m", "m", "feat/a"])
    await execGit(repo, ["merge", "-q", "--no-ff", "-m", "m2", "feat/b"])
    await execGit(repo, ["push", "-q", "origin", "main", "feat/a", "feat/b"])
    await execGit(repo, ["fetch", "-q", "origin"])
    // A tracking ref that never existed upstream — git refuses the whole batch over it.
    await execGit(repo, ["update-ref", "refs/remotes/origin/ghost", await sha(repo, "main")])
    await execGit(repo, ["branch", "-q", "-D", "feat/a", "feat/b"])
    const p = await plan(repo, { base: "origin/main" })
    // Only `ghost` is missing upstream: the batch delete of feat/a and
    // feat/b is refused wholesale, and the RETRY BATCH must delete them.

    const { outcomes } = await applyBranchGc(p, { scopes: ["remote"], forge: new FakeForge(), stateDir: await tmp("branch-gc-state-"), fetch: false })
    expect(outcomes.find((o) => o.name === "ghost")?.result).not.toBe("failed")
    expect(outcomes.find((o) => o.name === "feat/a")?.result).toBe("deleted")
    expect(outcomes.find((o) => o.name === "feat/b")?.result).toBe("deleted")
    expect(await refExists(bare, "refs/heads/feat/a")).toBe(false)
    expect(await refExists(bare, "refs/heads/feat/b")).toBe(false)
  })

  it("the per-ref fallback skips refs the partial retry already deleted upstream", async () => {
    const repo = await makeRepo()
    const bare = await withOrigin(repo)
    await branchWith(repo, "feat/a", { "a.txt": "a\n" })
    await branchWith(repo, "feat/b", { "b.txt": "b\n" })
    await execGit(repo, ["merge", "-q", "--no-ff", "-m", "m", "feat/a"])
    await execGit(repo, ["merge", "-q", "--no-ff", "-m", "m2", "feat/b"])
    await execGit(repo, ["push", "-q", "origin", "main", "feat/a", "feat/b"])
    await execGit(repo, ["fetch", "-q", "origin"])
    // A tracking ref that never existed upstream — git refuses the whole batch over it.
    await execGit(repo, ["update-ref", "refs/remotes/origin/ghost", await sha(repo, "main")])
    await execGit(repo, ["branch", "-q", "-D", "feat/a", "feat/b"])
    const p = await plan(repo, { base: "origin/main" })
    // feat/a vanishes upstream between plan and apply. feat/b must vanish
    // DURING the batch retry — simulated with a bare pre-receive hook that
    // really deletes every pushed ref and then exits 1: non-atomic, so a
    // push both succeeds on the wire and "fails" by exit code, leaving a
    // stale tracking ref behind. remoteBatchSize 1 isolates the ghost in
    // its own refused batch so feat/b's delete reaches the retry round.
    const hook = join(bare, "hooks", "pre-receive")
    await mkdir(dirname(hook), { recursive: true })
    await writeFile(hook, '#!/bin/sh\nwhile read -r _old _rev ref; do git update-ref -d "$ref" 2>/dev/null || :; done\nexit 1\n')
    await chmod(hook, 0o755)
    await execGit(bare, ["update-ref", "-d", "refs/heads/feat/a"])

    const { outcomes } = await applyBranchGc(p, { scopes: ["remote"], forge: new FakeForge(), stateDir: await tmp("branch-gc-state-"), fetch: false, remoteBatchSize: 1 })
    // The retry "fails" (exit 1) but deletes feat/b for real; the per-ref
    // fallback must not record it as `failed`.
    expect(outcomes.find((o) => o.name === "ghost")?.result).not.toBe("failed")
    expect(outcomes.find((o) => o.name === "feat/b")?.result).toBe("deleted")
    expect(outcomes.some((o) => o.result === "failed")).toBe(false)
    expect(await refExists(bare, "refs/heads/feat/b")).toBe(false)
  })
})

// ── sandbox checkpoint branches ──────────────────────────────────────────

describe("branch gc — sandbox checkpoint branches", () => {
  /** Park a checkpoint ref on origin the way a sandbox box force-pushes its
   *  snapshot, then refresh the tracking refs. */
  async function pushCheckpoint(repo: string, work: string, tip: string): Promise<void> {
    await execGit(repo, ["push", "-q", "origin", `${tip}:refs/heads/${CHECKPOINT_BRANCH_PREFIX}${work}`])
    await execGit(repo, ["fetch", "-q", "origin"])
  }

  it("checkpoint ref, work branch merged: reclaim with checkpoint-superseded", async () => {
    const repo = await makeRepo()
    await withOrigin(repo)
    const tip = await branchWith(repo, "wt/feat", { "w.txt": "w\n" })
    await execGit(repo, ["merge", "-q", "--ff-only", "wt/feat"])
    await execGit(repo, ["push", "-q", "origin", "main"])
    // A snapshot commit taken ON the merged work tip — `<checkpoint>^` is
    // the tip that landed, like a real box's snapshot.
    await execGit(repo, ["checkout", "-q", "-b", "tmp/snap", "wt/feat"])
    const snap = await commitFiles(repo, { "s.txt": "s\n" }, "snapshot")
    await execGit(repo, ["checkout", "-q", "main"])
    await execGit(repo, ["branch", "-q", "-D", "tmp/snap"])
    await pushCheckpoint(repo, "wt/feat", snap)

    const e = entry(await plan(repo, { base: "origin/main" }), `${CHECKPOINT_BRANCH_PREFIX}wt/feat`, "remote")
    expect(e).toMatchObject({ class: "reclaim", reclaimReason: "checkpoint-superseded", status: "merged" })
    expect(await sha(repo, `${snap}^`)).toBe(tip)
  })

  it("checkpoint ref, work branch unmerged: review, never auto-reclaimed", async () => {
    const repo = await makeRepo()
    await withOrigin(repo)
    const tip = await branchWith(repo, "wt/wip", { "w.txt": "w\n" })
    await pushCheckpoint(repo, "wt/wip", tip)

    const p = await plan(repo, { base: "origin/main" })
    expect(entry(p, `${CHECKPOINT_BRANCH_PREFIX}wt/wip`, "remote")).toMatchObject({ class: "review", status: "unmerged" })
    expect(entry(p, "wt/wip")).toMatchObject({ class: "review" })
  })

  it("checkpoint ref, work branch gone: review — the snapshot may be the only copy", async () => {
    const repo = await makeRepo()
    await withOrigin(repo)
    const snap = await branchWith(repo, "tmp/snap", { "s.txt": "s\n" })
    await pushCheckpoint(repo, "wt/dead", snap)
    await execGit(repo, ["branch", "-q", "-D", "tmp/snap"])

    const e = entry(await plan(repo, { base: "origin/main" }), `${CHECKPOINT_BRANCH_PREFIX}wt/dead`, "remote")
    expect(e).toMatchObject({ class: "review", status: "unmerged" })
  })

  it("an OLD merged PR with the same reused work-branch name but a different head is review", async () => {
    const repo = await makeRepo()
    await withOrigin(repo)
    // The generation PR #55 landed — long gone from the branch.
    const oldHead = await branchWith(repo, "tmp/old", { "old.txt": "old\n" })
    await execGit(repo, ["branch", "-q", "-D", "tmp/old"])
    // A NEW checkpoint of the reused name: its snapshot parent is unrelated
    // to the PR's head, so the old PR proves nothing about it.
    const snap = await branchWith(repo, "tmp/snap", { "s.txt": "s\n" })
    await pushCheckpoint(repo, "wt/reused", snap)
    await execGit(repo, ["branch", "-q", "-D", "tmp/snap"])

    const forge = new FakeForge([], [mergedPr(55, "wt/reused", oldHead)])
    const e = entry(await plan(repo, { base: "origin/main", forge }), `${CHECKPOINT_BRANCH_PREFIX}wt/reused`, "remote")
    expect(e).toMatchObject({ class: "review", status: "unmerged" })
  })

  it("a snapshot taken on a commit AFTER the merged tip is review, not reclaim", async () => {
    const repo = await makeRepo()
    await withOrigin(repo)
    const landed = await branchWith(repo, "wt/late", { "a.txt": "a\n" })
    await execGit(repo, ["merge", "-q", "--ff-only", "wt/late"])
    await execGit(repo, ["push", "-q", "origin", "main", "wt/late"])
    await execGit(repo, ["fetch", "-q", "origin"])
    // The box kept going: work HEAD moved past what landed, and the snapshot
    // was taken on THAT later commit — the extra work may never have landed.
    await execGit(repo, ["checkout", "-q", "wt/late"])
    await commitFiles(repo, { "b.txt": "b\n" }, "post-land work")
    await execGit(repo, ["checkout", "-q", "-b", "tmp/snap", "wt/late"])
    const snap = await commitFiles(repo, { "s.txt": "s\n" }, "snapshot")
    await execGit(repo, ["checkout", "-q", "main"])
    await execGit(repo, ["branch", "-q", "-D", "tmp/snap"])
    await pushCheckpoint(repo, "wt/late", snap)

    const e = entry(await plan(repo, { base: "origin/main" }), `${CHECKPOINT_BRANCH_PREFIX}wt/late`, "remote")
    expect(e).toMatchObject({ class: "review" })
    expect(await sha(repo, `${snap}^`)).not.toBe(landed)
  })

  function checkpointVerdict(name: string, snapshot: string, agree: boolean) {
    return {
      name,
      sha: snapshot,
      reviewer: "flash reviewer",
      triage: { verdict: "obsolete", confidence: 0.9, reason: "dead experiment" },
      gate: { agree, verdict: "obsolete", reason: "nothing unique", evidence: ["base has the work"] },
    }
  }

  /** Snapshot `work`'s current tip, park the snapshot as the checkpoint ref, return its sha. */
  async function pushSnapshot(repo: string, work: string): Promise<string> {
    await execGit(repo, ["checkout", "-q", "-b", "tmp/snap", work])
    const snap = await commitFiles(repo, { "s.txt": "s\n" }, "snapshot")
    await execGit(repo, ["checkout", "-q", "main"])
    await execGit(repo, ["branch", "-q", "-D", "tmp/snap"])
    await pushCheckpoint(repo, work, snap)
    return snap
  }

  it("checkpoint ref with a stored verdict for its snapshot sha carries that verdict", async () => {
    const repo = await makeRepo()
    await withOrigin(repo)
    await branchWith(repo, "wt/judged", { "w.txt": "w\n" })
    const snap = await pushSnapshot(repo, "wt/judged")
    const verdicts = new InMemoryBranchVerdictStore()
    await recordBranchVerdict({ repoRoot: repo, repoName: "fixture", store: verdicts, verdict: checkpointVerdict("wt/judged", snap, false) })

    const e = entry(await plan(repo, { base: "origin/main", verdicts }), `${CHECKPOINT_BRANCH_PREFIX}wt/judged`, "remote")
    expect(e).toMatchObject({ class: "review", status: "unmerged", verdict: { agree: false, triage: "obsolete", reviewer: "flash reviewer" } })
  })

  it("includeReviewed reclaims a checkpoint ref whose agreeing verdict has sufficient line coverage", async () => {
    const repo = await makeRepo()
    await withOrigin(repo)
    await commitFiles(repo, { "src/b.ts": "header\n" }, "b")
    await branchWith(repo, "wt/landed", { "src/b.ts": "header\nconst alpha = 1\nconst beta = 2\n" })
    await commitFiles(repo, { "src/b.ts": "const alpha = 1\nconst beta = 2\nheader\n// base moved it\n" }, "base landed it differently")
    await execGit(repo, ["push", "-q", "origin", "main"])
    const snap = await pushSnapshot(repo, "wt/landed")
    const verdicts = new InMemoryBranchVerdictStore()
    await recordBranchVerdict({ repoRoot: repo, repoName: "fixture", store: verdicts, verdict: checkpointVerdict("wt/landed", snap, true) })

    const e = entry(
      await plan(repo, { base: "origin/main", verdicts, includeReviewed: true }),
      `${CHECKPOINT_BRANCH_PREFIX}wt/landed`,
      "remote",
    )
    expect(e.lineCoverage).toMatchObject({ added: 2, inBase: 2, pct: 100 })
    expect(e).toMatchObject({ class: "reclaim", reclaimReason: "reviewed", verdict: { agree: true } })
    expect(e.verdictGuard).toBeUndefined()
  })

  it("includeReviewed refuses an under-coverage checkpoint verdict and records verdictGuard", async () => {
    const repo = await makeRepo()
    await withOrigin(repo)
    await commitFiles(repo, { "src/a.ts": "export const base = 1\n" }, "a")
    await branchWith(repo, "wt/lost", {
      "src/a.ts": "export const base = 1\nexport function lostWork() { return 42 }\nexport const alsoLost = 'value'\n",
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\nimporters: something-long-enough\n",
    })
    await commitFiles(repo, { "src/a.ts": "export const base = 2\n" }, "base edits a.ts")
    await execGit(repo, ["push", "-q", "origin", "main"])
    const snap = await pushSnapshot(repo, "wt/lost")
    const verdicts = new InMemoryBranchVerdictStore()
    await recordBranchVerdict({ repoRoot: repo, repoName: "fixture", store: verdicts, verdict: checkpointVerdict("wt/lost", snap, true) })

    const e = entry(
      await plan(repo, { base: "origin/main", verdicts, includeReviewed: true }),
      `${CHECKPOINT_BRANCH_PREFIX}wt/lost`,
      "remote",
    )
    expect(e).toMatchObject({ class: "review", status: "unmerged", verdict: { agree: true } })
    expect(e.reclaimReason).toBeUndefined()
    expect(e.verdictGuard).toBe("line coverage 0% of 2 added lines (< 95%)")
  })

  it("includeReviewed refuses a work-branch-less checkpoint verdict with no measurable coverage", async () => {
    const repo = await makeRepo()
    await withOrigin(repo)
    // An orphan snapshot: no common history with base, so the ladder has no
    // lines to measure against — exactly the "work branch is gone" rescue case.
    await execGit(repo, ["checkout", "-q", "--orphan", "tmp/snap"])
    await execGit(repo, ["rm", "-q", "-rf", "."])
    const snap = await commitFiles(repo, { "rescued.txt": "only copy of the rescued work\n" }, "orphan snapshot")
    await execGit(repo, ["checkout", "-q", "main"])
    await execGit(repo, ["branch", "-q", "-D", "tmp/snap"])
    await pushCheckpoint(repo, "wt/dead", snap)
    const verdicts = new InMemoryBranchVerdictStore()
    await recordBranchVerdict({ repoRoot: repo, repoName: "fixture", store: verdicts, verdict: checkpointVerdict("wt/dead", snap, true) })

    const e = entry(await plan(repo, { base: "origin/main", verdicts, includeReviewed: true }), `${CHECKPOINT_BRANCH_PREFIX}wt/dead`, "remote")
    expect(e).toMatchObject({ class: "review", status: "unmerged", verdict: { agree: true } })
    expect(e.reclaimReason).toBeUndefined()
    expect(e.verdictGuard).toBe("no line coverage for checkpoint snapshot")
  })

  it("includeReviewed guards the CHECKPOINT snapshot's coverage, not the work branch's", async () => {
    const repo = await makeRepo()
    await withOrigin(repo)
    await commitFiles(repo, { "src/b.ts": "header\n" }, "b")
    await branchWith(repo, "wt/hi", { "src/b.ts": "header\nconst alpha = 1\nconst beta = 2\n" })
    await commitFiles(repo, { "src/b.ts": "const alpha = 1\nconst beta = 2\nheader\n// base moved it\n" }, "base landed it differently")
    await execGit(repo, ["push", "-q", "origin", "main"])
    // The work tip is fully covered by base, but the snapshot taken on it adds
    // unlanded work — the snapshot is what the verdict covers.
    await execGit(repo, ["checkout", "-q", "-b", "tmp/snap", "wt/hi"])
    const snap = await commitFiles(
      repo,
      { "src/c.ts": "export function rescued() { return 99 }\nexport const alsoRescued = 'yes'\n" },
      "snapshot with unlanded work",
    )
    await execGit(repo, ["checkout", "-q", "main"])
    await execGit(repo, ["branch", "-q", "-D", "tmp/snap"])
    await pushCheckpoint(repo, "wt/hi", snap)
    const verdicts = new InMemoryBranchVerdictStore()
    await recordBranchVerdict({ repoRoot: repo, repoName: "fixture", store: verdicts, verdict: checkpointVerdict("wt/hi", snap, true) })

    const p = await plan(repo, { base: "origin/main", verdicts, includeReviewed: true })
    expect(entry(p, "wt/hi").lineCoverage).toMatchObject({ pct: 100 })
    const e = entry(p, `${CHECKPOINT_BRANCH_PREFIX}wt/hi`, "remote")
    expect(e.lineCoverage?.pct).toBeLessThan(95)
    expect(e).toMatchObject({ class: "review", status: "unmerged", verdict: { agree: true } })
    expect(e.reclaimReason).toBeUndefined()
    expect(e.verdictGuard).toContain("line coverage")
  })
})

// ── forge-mirror orphans ─────────────────────────────────────────────────

describe("branch gc — forge-mirror orphans", () => {
  /** Push `tip` as the bare origin's `refs/pull/<n>/head`, mirror it the way agents do, drop the local branch. */
  async function prMirror(repo: string, n: number, branch: string, files: Record<string, string>): Promise<string> {
    const tip = await branchWith(repo, branch, files)
    await execGit(repo, ["push", "-q", "origin", `${tip}:refs/pull/${n}/head`])
    await execGit(repo, ["fetch", "-q", "origin", `+refs/pull/${n}/head:refs/remotes/pr/${n}`])
    await execGit(repo, ["branch", "-q", "-D", branch])
    return tip
  }

  it("an orphan ref whose tip IS a refs/pull/N/head is reclaim (forge-mirror), skipping the ladder", async () => {
    const repo = await makeRepo()
    await withOrigin(repo)
    const tip = await prMirror(repo, 7, "tmp-pr7", { "pr7.txt": "unmerged work only in the PR\n" })
    // Same namespace, but not a PR head: still the normal ladder.
    const lost = await branchWith(repo, "tmp-lost", { "lost.txt": "only here\n" })
    await execGit(repo, ["update-ref", "refs/remotes/pr/stray", lost])
    await execGit(repo, ["branch", "-q", "-D", "tmp-lost"])

    const p = await plan(repo, { base: "origin/main" })
    expect(p.forgeMirrorCheck).toEqual({ available: true })
    const e = entry(p, "pr/7", "orphan")
    expect(e).toMatchObject({ sha: tip, status: "forge-mirror", class: "reclaim", reclaimReason: "forge-mirror", forgePr: 7 })
    expect(e.coverage).toBeUndefined()
    expect(entry(p, "pr/stray", "orphan")).toMatchObject({ class: "review", pushed: "only-copy" })
    expect(summarizeBranchGcPlan(p).byStatus.orphan["forge-mirror"]).toBe(1)
  })

  it("apply deletes it and the restore log re-fetches the PR head, not update-ref", async () => {
    const repo = await makeRepo()
    await withOrigin(repo)
    const tip = await prMirror(repo, 12, "tmp-pr12", { "pr12.txt": "x\n" })
    const p = await plan(repo, { base: "origin/main" })
    const stateDir = await tmp("branch-gc-state-")
    const { outcomes, restoreLog } = await applyBranchGc(p, { scopes: ["orphan"], forge: new FakeForge(), stateDir })
    expect(outcomes).toContainEqual({ kind: "orphan", name: "pr/12", sha: tip, result: "deleted", reclaimReason: "forge-mirror" })
    expect(await refExists(repo, "refs/remotes/pr/12")).toBe(false)

    const log = await readBranchGcRestoreLog(restoreLog as string)
    expect(log.entries).toHaveLength(1)
    expect(log.entries[0]?.argv).toEqual(["fetch", "origin", "+refs/pull/12/head:refs/remotes/pr/12"])
    expect(log.entries[0]?.command).toMatch(/^git -C \S+ fetch origin \+refs\/pull\/12\/head:refs\/remotes\/pr\/12$/)
    await execGit(repo, log.entries[0]?.argv as string[])
    expect(await sha(repo, "refs/remotes/pr/12")).toBe(tip)
  })

  it("ls-remote failing falls back to the normal ladder (no shortcut, nothing reclaimed on faith)", async () => {
    const repo = await makeRepo()
    await withOrigin(repo)
    await prMirror(repo, 3, "tmp-pr3", { "pr3.txt": "only in the PR\n" })
    await execGit(repo, ["remote", "set-url", "origin", join(await tmp("branch-gc-gone-"), "missing.git")])
    const p = await plan(repo, { base: "origin/main", fetch: false })
    expect(p.forgeMirrorCheck.available).toBe(false)
    expect(p.forgeMirrorCheck.reason).toBeTruthy()
    expect(entry(p, "pr/3", "orphan")).toMatchObject({ status: "unmerged", class: "review", pushed: "only-copy" })
  })

  it("only orphans get the shortcut: a local branch at a PR head is classified as usual", async () => {
    const repo = await makeRepo()
    await withOrigin(repo)
    const tip = await branchWith(repo, "feat/pr9", { "pr9.txt": "x\n" })
    await execGit(repo, ["push", "-q", "origin", `${tip}:refs/pull/9/head`])
    expect(entry(await plan(repo, { base: "origin/main" }), "feat/pr9")).toMatchObject({ status: "unmerged", class: "review" })
  })
})

// ── line-coverage guard on reviewed verdicts ─────────────────────────────

describe("branch gc — line-coverage guard", () => {
  function agreeing(name: string, tip: string) {
    return {
      name,
      sha: tip,
      reviewer: "flash reviewer",
      triage: { verdict: "superseded", confidence: 0.9, reason: "landed" },
      gate: { agree: true, verdict: "superseded", reason: "base has it", evidence: ["base has src/a.ts"] },
    }
  }

  /** An evolved file whose added lines are NOT in base (base kept editing it differently), plus a lockfile. */
  async function lowCoverageBranch(repo: string): Promise<string> {
    await commitFiles(repo, { "src/a.ts": "export const base = 1\n" }, "a")
    const tip = await branchWith(repo, "feat/lost", {
      "src/a.ts": "export const base = 1\nexport function lostWork() { return 42 }\nexport const alsoLost = 'value'\n",
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\nimporters: something-long-enough\n",
    })
    await commitFiles(repo, { "src/a.ts": "export const base = 2\n" }, "base edits a.ts")
    return tip
  }

  it("unmerged entries carry lineCoverage over evolved+unique files (lockfiles skipped, trivial lines ignored)", async () => {
    const repo = await makeRepo()
    await lowCoverageBranch(repo)
    const e = entry(await plan(repo), "feat/lost")
    expect(e.class).toBe("review")
    expect(e.lineCoverage).toEqual({
      added: 2,
      inBase: 0,
      pct: 0,
      missing: [
        { file: "src/a.ts", line: "export function lostWork() { return 42 }" },
        { file: "src/a.ts", line: "export const alsoLost = 'value'" },
      ],
    })
  })

  it("includeReviewed refuses an agreeing verdict under minLineCoverage; apply reports refused-guard", async () => {
    const repo = await makeRepo()
    const tip = await lowCoverageBranch(repo)
    const verdicts = new InMemoryBranchVerdictStore()
    await recordBranchVerdict({ repoRoot: repo, repoName: "fixture", store: verdicts, verdict: agreeing("feat/lost", tip) })

    const p = await plan(repo, { verdicts, includeReviewed: true })
    expect(p.minLineCoverage).toBe(95)
    const e = entry(p, "feat/lost")
    expect(e).toMatchObject({ class: "review", verdict: { agree: true } })
    expect(e.reclaimReason).toBeUndefined()
    expect(e.verdictGuard).toBe("line coverage 0% of 2 added lines (< 95%)")

    const { outcomes, restoreLog } = await applyBranchGc(p, { scopes: ["local"], forge: new FakeForge(), verdicts, stateDir: await tmp("branch-gc-state-") })
    expect(outcomes).toContainEqual({ kind: "local", name: "feat/lost", sha: tip, result: "refused-guard", guard: e.verdictGuard })
    expect(restoreLog).toBeNull()
    expect(await refExists(repo, "refs/heads/feat/lost")).toBe(true)

    // The threshold is configurable: at 0 the same verdict reclaims.
    expect(entry(await plan(repo, { verdicts, includeReviewed: true, minLineCoverage: 0 }), "feat/lost")).toMatchObject({
      class: "reclaim",
      reclaimReason: "reviewed",
    })
    await expect(plan(repo, { minLineCoverage: 101 })).rejects.toThrow(/minLineCoverage/)
  })

  it("an operator approval reclaims a guard-refused tip, records who bypassed it, and still writes the restore log", async () => {
    const repo = await makeRepo()
    const tip = await lowCoverageBranch(repo)
    const verdicts = new InMemoryBranchVerdictStore()
    await recordBranchVerdict({
      repoRoot: repo,
      repoName: "fixture",
      store: verdicts,
      verdict: { ...agreeing("feat/lost", tip), operator: { by: "jeremy", note: "checked the missing work by hand" } },
    })

    const p = await plan(repo, { verdicts, includeReviewed: true })
    const e = entry(p, "feat/lost")
    expect(e).toMatchObject({ class: "reclaim", reclaimReason: "reviewed", verdict: { agree: true, operator: { by: "jeremy" } } })
    expect(e.verdictGuard).toContain("bypassed by operator jeremy")
    expect(e.verdictGuard).toContain("line coverage 0%")

    const stateDir = await tmp("branch-gc-state-")
    const { outcomes, restoreLog } = await applyBranchGc(p, { scopes: ["local"], forge: new FakeForge(), verdicts, stateDir })
    expect(outcomes).toContainEqual({ kind: "local", name: "feat/lost", sha: tip, result: "deleted", reclaimReason: "reviewed" })
    expect(restoreLog).not.toBeNull()
    const log = await readBranchGcRestoreLog(restoreLog as string)
    expect(log.entries).toContainEqual(expect.objectContaining({ name: "feat/lost", sha: tip }))
    expect(await refExists(repo, "refs/heads/feat/lost")).toBe(false)
  })

  it("an operator block without gate.agree is not an approval: the tip stays review", async () => {
    const repo = await makeRepo()
    const tip = await lowCoverageBranch(repo)
    const verdicts = new InMemoryBranchVerdictStore()
    const verdict = agreeing("feat/lost", tip)
    await recordBranchVerdict({
      repoRoot: repo,
      repoName: "fixture",
      store: verdicts,
      verdict: { ...verdict, gate: { ...verdict.gate, agree: false }, operator: { by: "jeremy" } },
    })

    const e = entry(await plan(repo, { verdicts, includeReviewed: true }), "feat/lost")
    expect(e).toMatchObject({ class: "review", verdict: { agree: false, operator: { by: "jeremy" } } })
    expect(e.verdictGuard).toBeUndefined()
  })

  it("apply re-checks the guard: a plan made with a lower threshold cannot carry a refused approval through", async () => {
    const repo = await makeRepo()
    const tip = await lowCoverageBranch(repo)
    const verdicts = new InMemoryBranchVerdictStore()
    await recordBranchVerdict({ repoRoot: repo, repoName: "fixture", store: verdicts, verdict: agreeing("feat/lost", tip) })
    const loose = await plan(repo, { verdicts, includeReviewed: true, minLineCoverage: 0 })
    expect(entry(loose, "feat/lost").class).toBe("reclaim")
    // A tampered/stale plan: the threshold it is applied with is the plan's own, so restore the default.
    const { outcomes } = await applyBranchGc({ ...loose, minLineCoverage: 95 }, { scopes: ["local"], forge: new FakeForge(), verdicts })
    expect(outcomes).toContainEqual(
      expect.objectContaining({ name: "feat/lost", result: "aborted-reclassified", from: "reclaim", to: "review" }),
    )
    expect(await refExists(repo, "refs/heads/feat/lost")).toBe(true)
  })

  it("an agreeing verdict on a tip whose added lines ARE in base (moved within the file) still reclaims", async () => {
    const repo = await makeRepo()
    await commitFiles(repo, { "src/b.ts": "header\n" }, "b")
    const tip = await branchWith(repo, "feat/landed", { "src/b.ts": "header\nconst alpha = 1\nconst beta = 2\n" })
    await commitFiles(repo, { "src/b.ts": "const alpha = 1\nconst beta = 2\nheader\n// base moved it\n" }, "base landed it differently")
    const verdicts = new InMemoryBranchVerdictStore()
    await recordBranchVerdict({ repoRoot: repo, repoName: "fixture", store: verdicts, verdict: agreeing("feat/landed", tip) })
    const e = entry(await plan(repo, { verdicts, includeReviewed: true }), "feat/landed")
    expect(e.status).toBe("unmerged")
    expect(e.lineCoverage).toMatchObject({ added: 2, inBase: 2, pct: 100, missing: [] })
    expect(e).toMatchObject({ class: "reclaim", reclaimReason: "reviewed" })
    expect(e.verdictGuard).toBeUndefined()
  })

  it("review queue exposes lineCoverage, taken from whichever ref sharing the tip carries it", async () => {
    const repo = await makeRepo()
    const tip = await lowCoverageBranch(repo)
    await execGit(repo, ["update-ref", "refs/remotes/gone/lost", tip])
    const p = await plan(repo)
    // Simulate a twin without coverage listed first (e.g. a mirror entry).
    const twin = { ...entry(p, "gone/lost", "orphan") }
    delete twin.lineCoverage
    const q = branchReviewQueue({ ...p, entries: [twin, ...p.entries.filter((x) => x.name !== "gone/lost")] })
    const c = q.candidates.find((x) => x.sha === tip)
    expect(c?.refs.sort()).toEqual(["refs/heads/feat/lost", "refs/remotes/gone/lost"])
    expect(c?.lineCoverage).toMatchObject({ added: 2, inBase: 0, pct: 0 })
  })
})

describe("approveBranchVerdict — operator approval copied from the stored verdict", () => {
  const verdict = (name: string, tip: string, agree: boolean) => ({
    name,
    sha: tip,
    reviewer: "claude reviewer",
    triage: { verdict: "obsolete" as const, confidence: 0.9, reason: "dead experiment" },
    gate: { agree, verdict: "obsolete" as const, reason: "nothing unique", evidence: ["abc123: base has it"] },
  })

  async function setup(agree = true) {
    const repo = await makeRepo()
    await withOrigin(repo)
    const tip = await branchWith(repo, "feat/guarded", { "g.txt": "g\n" })
    await execGit(repo, ["push", "-q", "origin", "feat/guarded"])
    await execGit(repo, ["fetch", "-q", "origin"])
    const store = new InMemoryBranchVerdictStore()
    await recordBranchVerdict({ repoRoot: repo, repoName: "fixture", store, verdict: verdict("feat/guarded", tip, agree) })
    return { repo, tip, store }
  }

  it("copies the stored verdict and adds only { by, note }, by sha or by branch name", async () => {
    const { repo, tip, store } = await setup()
    const res = await approveBranchVerdict({ repoRoot: repo, repoName: "fixture", store, target: "feat/guarded", by: "Jeremy", note: "superseded by #12" })
    expect(res).toMatchObject({ ok: true, status: "recorded", name: "feat/guarded", sha: tip })
    if (!res.ok) throw new Error("unreachable")
    // A local branch and its origin twin at the same tip are both reported.
    expect(res.refs.sort()).toEqual(["refs/heads/feat/guarded", "refs/remotes/origin/feat/guarded"])
    const stored = await store.get("fixture", tip)
    expect(stored).toMatchObject({ ...verdict("feat/guarded", tip, true), operator: { by: "Jeremy", note: "superseded by #12" } })
    // A second approval leaves the first one alone.
    const again = await approveBranchVerdict({ repoRoot: repo, repoName: "fixture", store, target: tip, by: "Someone" })
    expect(again).toMatchObject({ ok: true, status: "already-approved" })
    expect((await store.get("fixture", tip))?.operator?.by).toBe("Jeremy")
  })

  it("--dry-run reports the verdict it would record and writes nothing", async () => {
    const { repo, tip, store } = await setup()
    const res = await approveBranchVerdict({ repoRoot: repo, repoName: "fixture", store, target: tip, by: "Jeremy", dryRun: true })
    expect(res).toMatchObject({ ok: true, status: "would-record", verdict: { sha: tip, operator: { by: "Jeremy" } } })
    expect((await store.get("fixture", tip))?.operator).toBeUndefined()
  })

  it("refuses with no stored verdict, a non-agreeing gate, a moved tip, or --by equal to the reviewer", async () => {
    const { repo, tip, store } = await setup()
    const approve = (target: string, by = "Jeremy", s = store) => approveBranchVerdict({ repoRoot: repo, repoName: "fixture", store: s, target, by })

    expect(await approve("f".repeat(40))).toMatchObject({ ok: false, refusal: "no-verdict" })
    expect(await approve("no/such-branch")).toMatchObject({ ok: false, refusal: "no-ref" })
    // Case-insensitive, like the schema's own check.
    expect(await approve(tip, "  CLAUDE reviewer ")).toMatchObject({ ok: false, refusal: "by-is-reviewer" })

    const disagreeing = new InMemoryBranchVerdictStore()
    await recordBranchVerdict({ repoRoot: repo, repoName: "fixture", store: disagreeing, verdict: verdict("feat/guarded", tip, false) })
    expect(await approve(tip, "Jeremy", disagreeing)).toMatchObject({ ok: false, refusal: "not-agreed" })
    const triageOnly = new InMemoryBranchVerdictStore()
    const { gate: _g, ...noGate } = verdict("feat/guarded", tip, true)
    await recordBranchVerdict({ repoRoot: repo, repoName: "fixture", store: triageOnly, verdict: noGate })
    expect(await approve(tip, "Jeremy", triageOnly)).toMatchObject({ ok: false, refusal: "not-agreed" })

    // The branch moves on (local and origin): the verdict is for an old tip.
    await execGit(repo, ["checkout", "-q", "feat/guarded"])
    await commitFiles(repo, { "more.txt": "more\n" }, "more work")
    await execGit(repo, ["push", "-q", "origin", "feat/guarded"])
    await execGit(repo, ["fetch", "-q", "origin"])
    await execGit(repo, ["checkout", "-q", "main"])
    expect(await approve(tip)).toMatchObject({ ok: false, refusal: "tip-moved" })
    expect(await approve("feat/guarded")).toMatchObject({ ok: false, refusal: "no-verdict" })
    expect((await store.get("fixture", tip))?.operator).toBeUndefined()
  })
})

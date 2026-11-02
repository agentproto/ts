/**
 * `applyGc`'s reviewed tier (`ApplyGcOptions.reviewed`): a held worktree whose
 * branch carries an agreeing stored verdict for its exact tip is removed
 * worktree-only, its branch kept for `branch gc`'s guard, and only after an
 * apply-time re-check. Real disposable git repos; the forge is a double.
 */
import { describe, it, expect, afterEach, vi } from "vitest"
import { mkdtemp, rm, writeFile, realpath, utimes } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { execGit } from "../exec.js"
import { planGc, applyGc, type GcApplyOutcome } from "../gc.js"
import { InMemoryVerdictMemoStore } from "../status.js"
import { InMemoryBranchVerdictStore, type BranchVerdictRecord } from "../branch-gc.js"
import type { ForgeClient, ForgePullRequestRef } from "../forge.js"

vi.setConfig({ testTimeout: 60_000 })

const cleanupPaths: string[] = []
afterEach(async () => {
  while (cleanupPaths.length > 0) {
    const p = cleanupPaths.pop() as string
    await rm(p, { recursive: true, force: true }).catch(() => {})
  }
})

const OLD = 61 * 60 * 1000

async function makeRepo(): Promise<string> {
  const repo = await realpath(await mkdtemp(join(tmpdir(), "wt-reviewed-")))
  cleanupPaths.push(repo)
  await execGit(repo, ["init", "-b", "main"])
  await execGit(repo, ["config", "user.email", "t@e.com"])
  await execGit(repo, ["config", "user.name", "T"])
  await writeFile(join(repo, "README.md"), "hello\n")
  await execGit(repo, ["add", "."])
  await execGit(repo, ["commit", "-m", "init"])
  return repo
}

async function headSha(cwd: string): Promise<string> {
  return (await execGit(cwd, ["rev-parse", "HEAD"])).stdout.trim()
}

async function backdateIndex(wtPath: string): Promise<void> {
  const index = (await execGit(wtPath, ["rev-parse", "--path-format=absolute", "--git-path", "index"])).stdout.trim()
  const old = new Date(Date.now() - OLD)
  await utimes(index, old, old)
}

/** An unmerged branch (one commit of its own) checked out in an idle worktree. */
async function heldWorktree(repo: string, branch: string): Promise<{ wtPath: string; tip: string }> {
  await execGit(repo, ["checkout", "-b", branch])
  await writeFile(join(repo, `${branch}.txt`), "x\n")
  await execGit(repo, ["add", "."])
  await execGit(repo, ["commit", "-m", `work on ${branch}`])
  const tip = await headSha(repo)
  await execGit(repo, ["checkout", "main"])
  const wtPath = join(repo, "..", `${branch}-${Math.random().toString(36).slice(2)}`)
  cleanupPaths.push(wtPath)
  await execGit(repo, ["worktree", "add", wtPath, branch])
  await backdateIndex(wtPath)
  return { wtPath, tip }
}

class FakeForge implements ForgeClient {
  constructor(private readonly prs: ForgePullRequestRef[] = []) {}
  async pullRequestsForBranch(): Promise<ForgePullRequestRef[]> {
    return this.prs
  }
  async pullRequestsForCommit(): Promise<ForgePullRequestRef[]> {
    return this.prs
  }
  async ensurePullHeadFetched(): Promise<void> {}
}

function verdict(sha: string, agree: boolean): BranchVerdictRecord {
  return {
    name: "feat",
    sha,
    triage: { verdict: "obsolete", confidence: 0.9, reason: "superseded" },
    gate: { agree, verdict: "obsolete", reason: "re-landed", evidence: ["git cherry"] },
    reviewer: "r",
    repo: "test-repo",
    recordedAt: "2026-11-01T00:00:00.000Z",
  }
}

async function setup(agree = true) {
  const repo = await makeRepo()
  const { wtPath, tip } = await heldWorktree(repo, "feat")
  const verdicts = new InMemoryBranchVerdictStore()
  await verdicts.set(verdict(tip, agree))
  const input = { repoRoot: repo, repoName: "test-repo", forge: new FakeForge(), memo: new InMemoryVerdictMemoStore(), defaultBranchRef: "main" }
  const plan = await planGc(input)
  expect(plan.find((e) => e.path === wtPath)?.class).toBe("hold")
  return { repo, wtPath, tip, verdicts, input, plan }
}

async function worktreeListed(repo: string, path: string): Promise<boolean> {
  return (await execGit(repo, ["worktree", "list", "--porcelain"])).stdout.includes(path)
}

async function branchExists(repo: string, branch: string): Promise<boolean> {
  return (await execGit(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])).exitCode === 0
}

describe("applyGc reviewed tier", () => {
  it("removes the agreed held worktree and KEEPS its branch", async () => {
    const { repo, wtPath, tip, verdicts, input, plan } = await setup()
    const outcome = (await applyGc(plan, { ...input, reviewed: { paths: [wtPath], verdicts } })).find((o) => o.path === wtPath)
    expect(outcome?.result).toBe("removed-keep-branch")
    expect(await worktreeListed(repo, wtPath)).toBe(false)
    expect(await branchExists(repo, "feat")).toBe(true)
    expect((await execGit(repo, ["rev-parse", "refs/heads/feat"])).stdout.trim()).toBe(tip)
  })

  it("without the path in `reviewed`, a held worktree stays held", async () => {
    const { repo, wtPath, verdicts, input, plan } = await setup()
    const outcome = (await applyGc(plan, { ...input, reviewed: { paths: [], verdicts } })).find((o) => o.path === wtPath)
    expect(outcome?.result).toBe("held")
    expect(await worktreeListed(repo, wtPath)).toBe(true)
  })

  it("refuses when the tip moved since the plan (the verdict was for another tip)", async () => {
    const { repo, wtPath, verdicts, input, plan } = await setup()
    await writeFile(join(wtPath, "later.txt"), "new work\n")
    await execGit(wtPath, ["add", "."])
    await execGit(wtPath, ["commit", "-m", "work after the review"])
    await backdateIndex(wtPath)
    const outcome = (await applyGc(plan, { ...input, reviewed: { paths: [wtPath], verdicts } })).find(
      (o) => o.path === wtPath,
    ) as GcApplyOutcome & { reason: string }
    expect(outcome.result).toBe("skipped-stale")
    expect(outcome.reason).toMatch(/HEAD moved/)
    expect(await worktreeListed(repo, wtPath)).toBe(true)
  })

  it("refuses when the tree got dirty since the plan", async () => {
    const { repo, wtPath, verdicts, input, plan } = await setup()
    await writeFile(join(wtPath, "wip.txt"), "uncommitted\n")
    const outcome = (await applyGc(plan, { ...input, reviewed: { paths: [wtPath], verdicts } })).find(
      (o) => o.path === wtPath,
    ) as GcApplyOutcome & { reason: string }
    expect(outcome.result).toBe("skipped-stale")
    expect(outcome.reason).toMatch(/tree is dirty/)
    expect(await worktreeListed(repo, wtPath)).toBe(true)
  })

  it("refuses without an agreeing stored verdict for the exact tip", async () => {
    const { repo, wtPath, verdicts, input, plan } = await setup(false)
    const disagree = (await applyGc(plan, { ...input, reviewed: { paths: [wtPath], verdicts } })).find(
      (o) => o.path === wtPath,
    ) as GcApplyOutcome & { reason: string }
    expect(disagree.result).toBe("skipped-stale")
    expect(disagree.reason).toMatch(/does not agree/)
    const none = (
      await applyGc(plan, { ...input, reviewed: { paths: [wtPath], verdicts: new InMemoryBranchVerdictStore() } })
    ).find((o) => o.path === wtPath) as GcApplyOutcome & { reason: string }
    expect(none.result).toBe("skipped-stale")
    expect(none.reason).toMatch(/no stored verdict/)
    expect(await worktreeListed(repo, wtPath)).toBe(true)
  })

  it("refuses with a live session in the worktree or an open PR", async () => {
    const { repo, wtPath, tip, verdicts, input, plan } = await setup()
    const live = (await applyGc(plan, { ...input, liveSessionCwds: [wtPath], reviewed: { paths: [wtPath], verdicts } })).find(
      (o) => o.path === wtPath,
    ) as GcApplyOutcome & { reason: string }
    expect(live.result).toBe("skipped-stale")
    expect(live.reason).toMatch(/not idle/)
    const openPr: ForgePullRequestRef = { number: 7, state: "open", merged: false, mergedAt: null, headRefName: "feat", headRefOid: tip }
    const open = (
      await applyGc(plan, { ...input, forge: new FakeForge([openPr]), reviewed: { paths: [wtPath], verdicts } })
    ).find((o) => o.path === wtPath) as GcApplyOutcome & { reason: string }
    expect(open.result).toBe("skipped-stale")
    expect(open.reason).toMatch(/open PR #7/)
    expect(await worktreeListed(repo, wtPath)).toBe(true)
  })
})

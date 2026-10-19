/**
 * `sandbox checkpoint-gc` engine tests, against a REAL local git repo (bare
 * remote in a tmp dir, a work clone, checkpoint refs pushed by hand in the
 * exact shape `sandbox-delivery.ts` produces: a snapshot commit whose parent
 * is the work-branch head the box snapshotted on). Covers the contract:
 *   orphan whose content is already in main   -> listed safe, apply deletes it
 *   orphan with unique content                -> keep, apply leaves it
 *   apply deletes only the safe ones
 * plus the merge-tree/cherry ladder that makes it robust to squash merges,
 * and the never-delete-unknown/parentless cases.
 */
import { describe, it, expect, afterEach } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import {
  planSandboxCheckpointGc,
  applySandboxCheckpointGc,
  type SandboxCheckpointGcEntry,
} from "../checkpoint-gc.js"

function git(cwd: string, args: string[]): void {
  const res = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" })
  if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr || res.stdout}`)
}

function out(cwd: string, args: string[], stdin?: string): string {
  const res = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", input: stdin })
  if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr || res.stdout}`)
  return res.stdout
}

interface World {
  cleanupPaths: string[]
  workDir: string
  originDir: string
  /** `refs/remotes/origin/main` — the content adjudication base. */
  baseRef: string
}

/** Bare remote + a work clone with a single seed commit on `branch`. */
function world(branch = "main"): World {
  const root = mkdtempSync(join(tmpdir(), "ckgc-"))
  const originDir = join(root, "origin.git")
  spawnSync("git", ["init", "--bare", originDir], { encoding: "utf8" })
  const workDir = join(root, "work")
  spawnSync("git", ["init", "-q", workDir], { encoding: "utf8" })
  git(workDir, ["config", "user.email", "gc@test"])
  git(workDir, ["config", "user.name", "gc"])
  writeFileSync(join(workDir, "seed.txt"), "seed\n")
  git(workDir, ["add", "."])
  git(workDir, ["commit", "-q", "-m", "seed"])
  git(workDir, ["branch", "-M", branch])
  git(workDir, ["remote", "add", "origin", originDir])
  git(workDir, ["push", "-q", "origin", branch])
  // Point the clone's remote HEAD at the branch so detectDefaultBranch sees
  // it even when it is neither main nor master.
  spawnSync("git", ["-C", workDir, "symbolic-ref", `refs/remotes/origin/HEAD`, `refs/remotes/origin/${branch}`])
  return {
    cleanupPaths: [root],
    originDir,
    workDir,
    baseRef: `refs/remotes/origin/${branch}`,
  }
}

/** Commit `content` on a fresh branch `wt/<name>` off the base branch and push the branch. */
function workBranch(w: World, name: string, fileName: string, content: string): string {
  const wDir = w.workDir
  const base = w.baseRef.replace("refs/remotes/origin/", "")
  git(wDir, ["checkout", "-q", base])
  git(wDir, ["checkout", "-q", "-b", `wt/${name}`])
  writeFileSync(join(wDir, fileName), content)
  git(wDir, ["add", "."])
  git(wDir, ["commit", "-q", "-m", `${name} work`])
  const tip = out(wDir, ["rev-parse", "HEAD"]).trim()
  git(wDir, ["push", "-q", "--no-verify", "origin", `wt/${name}`])
  git(wDir, ["checkout", "-q", base])
  return tip
}

/**
 * The shape `sandbox-delivery.ts` pushes: a snapshot commit whose tree is the
 * box checkout's tree (here: the work branch tip's tree) and whose parent is
 * the work-branch head, force-pushed to `agentproto-checkpoint/wt/<name>`.
 */
function pushCheckpoint(w: World, name: string, p: string): string {
  const wDir = w.workDir
  const tree = out(wDir, ["rev-parse", `${p}^{tree}`]).trim()
  const snapSha = out(wDir, ["commit-tree", tree, "-p", p, "-m", "agentproto checkpoint"]).trim()
  git(wDir, ["push", "-q", "--no-verify", "origin", `+${snapSha}:refs/heads/agentproto-checkpoint/wt/${name}`])
  return snapSha
}

/**
 * The dead-box shape: the snapshot carries the work head PLUS uncommitted
 * delta (an extra file the checkout had but no branch or commit contains).
 * `credit` names the uncommitted file and its content.
 */
function pushCheckpointWithUncommitted(
  w: World,
  name: string,
  p: string,
  fileName: string,
  content: string,
): string {
  const wDir = w.workDir
  const parentTree = out(wDir, ["rev-parse", `${p}^{tree}`]).trim()
  const entries = out(wDir, ["cat-file", "-p", parentTree]).trimEnd()
  const blob = out(wDir, ["hash-object", "-t", "blob", "-w", "--stdin"], content).trim()
  const tree = out(wDir, ["mktree"], `${entries}\n100644 blob ${blob}\t${fileName}\n`).trim()
  const snapSha = out(wDir, ["commit-tree", tree, "-p", p, "-m", "agentproto checkpoint"]).trim()
  git(wDir, ["push", "-q", "--no-verify", "origin", `+${snapSha}:refs/heads/agentproto-checkpoint/wt/${name}`])
  return snapSha
}

/** Squash-merge `wt/<name>`'s content onto the base branch and push (fast path: `git merge --squash`). */
function squashIntoBase(w: World, branch: string, name: string): void {
  git(w.workDir, ["checkout", "-q", branch])
  git(w.workDir, ["merge", "--squash", `wt/${name}`])
  git(w.workDir, ["commit", "-q", "-m", `squash of wt/${name}`])
  git(w.workDir, ["push", "-q", "--no-verify", "origin", branch])
}

interface PlanOut {
  entry(name: string): SandboxCheckpointGcEntry | undefined
  names: string[]
}

/** Plan with an explicit base ref. */
async function plan(w: World): Promise<PlanOut> {
  const p = await planSandboxCheckpointGc({ repoRoot: w.workDir, remote: "origin", base: w.baseRef })
  return {
    entry(name) {
      return p.refs.find(e => e.ref === `agentproto-checkpoint/wt/${name}`)
    },
    names: p.refs.map(e => e.ref),
  }
}

/** Like `plan`, but lets the engine derive the base from the default branch. */
async function planAuto(w: World): Promise<PlanOut> {
  const p = await planSandboxCheckpointGc({ repoRoot: w.workDir, remote: "origin" })
  return {
    entry(name) {
      return p.refs.find(e => e.ref === `agentproto-checkpoint/wt/${name}`)
    },
    names: p.refs.map(e => e.ref),
  }
}

const cleanupPaths: string[] = []
afterEach(() => {
  while (cleanupPaths.length) rmSync(cleanupPaths.pop()!, { recursive: true, force: true })
})

describe("planSandboxCheckpointGc", () => {
  it("squash-merged content is safe: the orphan whose work is in main is listed for deletion", async () => {
    const w = world()
    cleanupPaths.push(...w.cleanupPaths)
    const parent = workBranch(w, "merged", "new.txt", "will land\n")
    pushCheckpoint(w, "merged", parent)
    squashIntoBase(w, "main", "merged")

    const p = await plan(w)
    const entry = p.entry("merged")
    expect(entry?.verdict).toBe("safe")
    expect(entry?.reason).toMatch(/merge-tree changes nothing|patch-merged|merged/)
    expect(entry?.workBranchOnRemote).toBe(true)
    expect(entry?.pr).toBeNull()
  })

  it("an orphan whose uncommitted content is nowhere else is kept while its work branch is unmerged", async () => {
    const w = world()
    cleanupPaths.push(...w.cleanupPaths)
    const parent = workBranch(w, "unique", "committed-already.txt", "committed on the branch\n")
    pushCheckpointWithUncommitted(w, "unique", parent, "unique.txt", "only in the box\n")

    const p = await plan(w)
    const entry = p.entry("unique")
    expect(entry?.verdict).toBe("keep")
    expect(entry?.reason).toContain("no proof")
  })

  it("a parentless snapshot is kept honestly", async () => {
    const w = world()
    cleanupPaths.push(...w.cleanupPaths)
    git(w.workDir, ["checkout", "-q", "main"])
    writeFileSync(join(w.workDir, "orphan.json"), "orphan content\n")
    git(w.workDir, ["add", "."])
    const tree = out(w.workDir, ["write-tree"]).trim()
    git(w.workDir, ["reset", "-q", "--hard"])
    const snapSha = out(w.workDir, ["commit-tree", tree, "-m", "agentproto checkpoint"]).trim()
    git(w.workDir, ["push", "-q", "--no-verify", "origin", `+${snapSha}:refs/heads/agentproto-checkpoint/wt/orphan`])

    const p = await plan(w)
    const entry = p.entry("orphan")
    expect(entry?.verdict).toBe("keep")
    expect(entry?.reason).toContain("parentless")
  })

  it("apply deletes only the safe refs and returns per-ref outcomes", async () => {
    const w = world()
    cleanupPaths.push(...w.cleanupPaths)
    // SAFE: content landed (main fast-forwarded through the work branch).
    const safeParent = workBranch(w, "safe", "landed.txt", "landed\n")
    pushCheckpoint(w, "safe", safeParent)
    git(w.workDir, ["checkout", "-q", "main"])
    git(w.workDir, ["merge", "-q", "--no-edit", "--ff", "wt/safe"])
    git(w.workDir, ["push", "-q", "--no-verify", "origin", "main"])
    // KEEP: unique uncommitted content the snapshot alone carries.
    const keepParent = workBranch(w, "keep", "kept.txt", "kept\n")
    pushCheckpointWithUncommitted(w, "keep", keepParent, "kept-uncommitted.txt", "only in the box\n")

    const p = await plan(w)
    expect(p.entry("safe")?.verdict).toBe("safe")
    expect(p.entry("keep")?.verdict).toBe("keep")

    const result = await applySandboxCheckpointGc({ repoRoot: w.workDir, remote: "origin", base: w.baseRef })
    expect(result.outcomes.map(o => [o.ref, o.result])).toEqual(
      expect.arrayContaining([
        ["agentproto-checkpoint/wt/keep", "skipped-keep"],
        ["agentproto-checkpoint/wt/safe", "deleted"],
      ]),
    )
    expect(out(w.workDir, ["ls-remote", "origin", "refs/heads/agentproto-checkpoint/wt/keep"]).trim()).not.toBe("")
    expect(out(w.workDir, ["ls-remote", "origin", "refs/heads/agentproto-checkpoint/wt/safe"]).trim()).toBe("")
  })
})

describe("planSandboxCheckpointGc fetch hardening (PR 2092 review)", () => {
  it("a gone work branch is not a fetch failure: its checkpoint is still safe when its content landed in the base", async () => {
    const w = world()
    cleanupPaths.push(...w.cleanupPaths)
    const parent = workBranch(w, "mergedgone", "new.txt", "will land\n")
    pushCheckpoint(w, "mergedgone", parent)
    squashIntoBase(w, "main", "mergedgone")
    // The main case the tool exists for: the work branch merged and was
    // deleted on the remote (and locally) BEFORE the plan runs.
    git(w.workDir, ["push", "-q", "--no-verify", "origin", "--delete", "wt/mergedgone"])
    git(w.workDir, ["branch", "-q", "-D", "wt/mergedgone"])

    const p = await plan(w)
    const entry = p.entry("mergedgone")
    expect(entry?.verdict).toBe("safe")
    expect(entry?.workBranchOnRemote).toBe(false)
  })

  it("a master-only repo is fully classified (no hardcoded main in the fetch)", async () => {
    const w = world("master")
    cleanupPaths.push(...w.cleanupPaths)
    const parent = workBranch(w, "onmaster", "new.txt", "will land\n")
    pushCheckpoint(w, "onmaster", parent)
    squashIntoBase(w, "master", "onmaster")

    const p = await planAuto(w)
    expect(p.names.length).toBe(1)
    const entry = p.entry("onmaster")
    expect(entry?.verdict).toBe("safe")
    expect(out(w.workDir, ["rev-parse", "--verify", "-q", "refs/remotes/origin/master"]).trim()).not.toBe("")
  })

  it("a default branch that is neither main nor master is used as the base", async () => {
    const w = world("trunk")
    cleanupPaths.push(...w.cleanupPaths)
    const parent = workBranch(w, "ontrunk", "new.txt", "will land\n")
    pushCheckpoint(w, "ontrunk", parent)
    squashIntoBase(w, "trunk", "ontrunk")

    const p = await planAuto(w)
    const entry = p.entry("ontrunk")
    expect(entry?.verdict).toBe("safe")
  })
})

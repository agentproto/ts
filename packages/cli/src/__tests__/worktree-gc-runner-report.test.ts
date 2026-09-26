/**
 * The repo-maintenance `maintain` report's Worktrees section read the wrong
 * key of `worktree_gc`'s dry-run result (`plan.worktrees`, a key that never
 * existed) and printed "0 worktree(s) classified" for a repo with 14 linked
 * worktrees. This runs the REAL daemon port (`makeWorktreeGcRunner`) over a
 * fixture repo with linked worktrees and feeds its result straight into the
 * workflow's own report helpers, so the two can't drift apart again.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath, pathToFileURL } from "node:url"

vi.mock("@agentproto/worktree", async importOriginal => {
  const real = await importOriginal<typeof import("@agentproto/worktree")>()
  // No `gh`/network in a unit test — the engine already treats an
  // unreachable forge as "unknown", which is all this test needs.
  return { ...real, createForgeClient: async () => new real.UnreachableForgeClient("test: no forge") }
})

import { makeWorktreeGcRunner } from "../commands/worktree.js"

vi.setConfig({ testTimeout: 60_000 })

const ENTRY = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "apps",
  "repo-maintenance",
  ".agentproto",
  "workflows",
  "maintain",
  "entry.mjs",
)

const cleanupPaths: string[] = []
const savedEnv: Record<string, string | undefined> = {}

beforeEach(async () => {
  // Isolate every ~/.agentproto read (sessions registry, verdict memo) and the
  // orphan-scan pool from the real machine.
  const home = realpathSync(await mkdtemp(join(tmpdir(), "wt-gc-report-home-")))
  cleanupPaths.push(home)
  for (const k of ["HOME", "AGENTPROTO_WORKTREES_ROOT"]) savedEnv[k] = process.env[k]
  process.env["HOME"] = home
  process.env["AGENTPROTO_WORKTREES_ROOT"] = join(home, "worktrees")
})

afterEach(async () => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  for (const p of cleanupPaths.splice(0)) await rm(p, { recursive: true, force: true }).catch(() => {})
})

function git(cwd: string, ...args: string[]): void {
  const res = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" })
  if (res.status !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr}`)
}

async function makeRepoWithLinkedWorktrees(): Promise<{ repo: string; worktrees: string[] }> {
  const repo = realpathSync(await mkdtemp(join(tmpdir(), "wt-gc-report-repo-")))
  cleanupPaths.push(repo)
  git(repo, "init", "-q", "-b", "main")
  git(repo, "config", "user.email", "t@t.t")
  git(repo, "config", "user.name", "t")
  await writeFile(join(repo, "f"), "x")
  git(repo, "add", ".")
  git(repo, "commit", "-q", "-m", "init")

  const pool = realpathSync(await mkdtemp(join(tmpdir(), "wt-gc-report-pool-")))
  cleanupPaths.push(pool)
  const worktrees: string[] = []
  for (const name of ["one", "two", "three"]) {
    const path = join(pool, name)
    git(repo, "worktree", "add", "-q", "-b", `wt/${name}`, path)
    worktrees.push(path)
  }
  // One dirty worktree, so the plan isn't trivially uniform.
  await writeFile(join(worktrees[2]!, "wip.txt"), "uncommitted\n")
  return { repo, worktrees }
}

describe("worktree_gc dry run → maintain report", () => {
  it("classifies every linked worktree and the report counts them by class", async () => {
    const { repo, worktrees } = await makeRepoWithLinkedWorktrees()

    const result = await makeWorktreeGcRunner()({
      repoRoot: repo,
      apply: false,
      salvageDirty: false,
      includeDetached: false,
      protectedPaths: [],
    })

    // The real shape: `plan` IS the entry array.
    expect(result.mode).toBe("plan")
    const plan = (result as { plan: Array<{ path: string; class: string }> }).plan
    expect(Array.isArray(plan)).toBe(true)
    expect(plan.map(e => e.path).sort()).toEqual([...worktrees].sort())

    const entry = (await import(pathToFileURL(ENTRY).href)) as {
      summarizeWorktreePlan: (r: unknown) => { total: number; byClass: Record<string, number> }
      buildReport: (b: unknown) => string
    }
    const summary = entry.summarizeWorktreePlan(result)
    expect(summary.total).toBe(3)
    const expected: Record<string, number> = { reclaim: 0, salvage: 0, hold: 0 }
    for (const e of plan) expected[e.class] = (expected[e.class] ?? 0) + 1
    expect(summary.byClass).toEqual(expected)

    const report = entry.buildReport({ input: {}, steps: { worktreeGcPlan: result } })
    expect(report).toContain("`plan` — 3 worktree(s) classified")
    expect(report).toContain(`reclaim=${expected.reclaim} salvage=${expected.salvage} hold=${expected.hold}`)
  })
})

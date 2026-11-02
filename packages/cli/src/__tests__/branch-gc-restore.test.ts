import { describe, it, expect, vi, afterEach } from "vitest"
import { execFileSync } from "node:child_process"
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { InMemoryBranchVerdictStore, recordBranchVerdict, repoLabel } from "@agentproto/worktree"
import { runBranch, runBranchGcRestore, makeBranchGcRestorer } from "../commands/branch.js"

function capture() {
  const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
  const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
  return {
    out: () => out.mock.calls.map(c => String(c[0])).join(""),
    err: () => err.mock.calls.map(c => String(c[0])).join(""),
  }
}

const dirs: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  while (dirs.length) await rm(dirs.pop() as string, { recursive: true, force: true })
})

const git = (cwd: string, ...args: string[]): string => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim()

/** A repo whose branch `feat/gone` was deleted, and a restore log for it (plus one for `feat/clash`, which exists elsewhere). */
async function deletedBranch() {
  const repo = await realpath(await mkdtemp(join(tmpdir(), "branch-restore-")))
  dirs.push(repo)
  git(repo, "init", "-q", "-b", "main")
  git(repo, "config", "user.email", "t@e.com")
  git(repo, "config", "user.name", "T")
  git(repo, "commit", "-q", "--allow-empty", "-m", "init")
  const base = git(repo, "rev-parse", "HEAD")
  git(repo, "checkout", "-q", "-b", "feat/gone")
  git(repo, "commit", "-q", "--allow-empty", "-m", "work")
  const sha = git(repo, "rev-parse", "HEAD")
  git(repo, "checkout", "-q", "main")
  git(repo, "branch", "-q", "-D", "feat/gone")
  git(repo, "branch", "-q", "feat/clash", base)
  const entry = (name: string) => ({
    kind: "local",
    name,
    ref: `refs/heads/${name}`,
    sha,
    argv: ["branch", name, sha],
    command: `git -C ${repo} branch ${name} ${sha}`,
    deleted: true,
  })
  const logPath = join(repo, "restore-test.json")
  await writeFile(
    logPath,
    JSON.stringify({ schema: "branch-gc-restore/v1", repoRoot: repo, base: "main", baseSha: base, createdAt: "2026-11-02T00:00:00Z", entries: [entry("feat/gone"), entry("feat/clash")] }),
  )
  return { repo, sha, base, logPath }
}

describe("agentproto branch gc restore", () => {
  it("is listed in the usage and needs exactly one restore log", async () => {
    const io = capture()
    expect(await runBranch(["--help"])).toBe(0)
    expect(io.out()).toContain("gc restore")
    expect(await runBranchGcRestore([])).toBe(2)
  })

  it("re-creates the selected ref, refuses one that exists at another sha, and drops the operator approval", async () => {
    const { repo, sha, base, logPath } = await deletedBranch()
    const store = new InMemoryBranchVerdictStore()
    await recordBranchVerdict({
      repoRoot: repo,
      repoName: repoLabel(repo),
      store,
      verdict: {
        name: "feat/gone",
        sha,
        reviewer: "flash reviewer",
        triage: { verdict: "superseded", confidence: 0.9, reason: "landed" },
        gate: { agree: true, verdict: "superseded", reason: "landed as #4", evidence: ["#4"] },
        operator: { by: "jeremy" },
      },
    })
    const io = capture()
    expect(await runBranchGcRestore([logPath, "--repo", repo, "--dry-run"], { storeFor: () => store })).toBe(1) // feat/clash conflicts
    expect(io.out()).toContain(`would-restore  git -C ${repo} branch feat/gone ${sha}`)
    expect(io.out()).toContain("refused-conflict")
    expect(() => git(repo, "rev-parse", "--verify", "--quiet", "refs/heads/feat/gone")).toThrow()

    expect(await runBranchGcRestore([logPath, "--repo", repo, "--sha", sha.slice(0, 8)], { storeFor: () => store })).toBe(1)
    expect(git(repo, "rev-parse", "refs/heads/feat/gone")).toBe(sha)
    expect(git(repo, "rev-parse", "refs/heads/feat/clash")).toBe(base)
    expect(io.out()).toContain("(operator approval dropped)")
    expect((await store.get(repoLabel(repo), sha))?.operator).toBeUndefined()
  })

  it("the daemon port returns the structured result", async () => {
    const { repo, sha, logPath } = await deletedBranch()
    const res = await makeBranchGcRestorer(() => new InMemoryBranchVerdictStore())({ logPath, repoRoot: repo, shas: [sha], dryRun: true })
    expect(res.repoRoot).toBe(repo)
    expect(res.outcomes.map(o => `${o.name}:${o.result}`)).toEqual(["feat/gone:would-restore", "feat/clash:refused-conflict"])
  })
})

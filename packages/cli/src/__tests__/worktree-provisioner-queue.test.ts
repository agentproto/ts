import { describe, it, expect, afterEach } from "vitest"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { realpathSync } from "node:fs"
import { spawnSync } from "node:child_process"
import {
  DEFAULT_PROVISION_CONCURRENCY,
  DEFAULT_PROVISION_LIMITS,
  PROVISION_CONCURRENCY_ENV,
  ProvisionCancelledError,
  provisionScheduler,
} from "@agentproto/worktree"
import {
  DEFAULT_WORKTREE_PROVISION_CONCURRENCY,
  WORKTREE_PROVISION_CONCURRENCY_ENV,
  type WorktreeProvisionProgress,
} from "@agentproto/runtime"
import { makeWorktreeProvisioner } from "../commands/worktree.js"

const cleanup: string[] = []

afterEach(async () => {
  delete process.env["AGENTPROTO_WORKTREES_ROOT"]
  delete process.env[PROVISION_CONCURRENCY_ENV]
  provisionScheduler.configure(DEFAULT_PROVISION_LIMITS)
  for (const p of cleanup.splice(0)) await rm(p, { recursive: true, force: true }).catch(() => {})
})

function git(cwd: string, ...args: string[]): void {
  const res = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" })
  if (res.status !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr}`)
}

async function makeRepo(): Promise<string> {
  const root = realpathSync(await mkdtemp(join(tmpdir(), "wt-prov-repo-")))
  cleanup.push(root)
  git(root, "init", "-q", "-b", "main")
  git(root, "config", "user.email", "t@t.t")
  git(root, "config", "user.name", "t")
  await writeFile(join(root, "f"), "x")
  git(root, "add", ".")
  git(root, "commit", "-q", "-m", "init")
  return root
}

async function makeConfig(worktrees: Record<string, unknown>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "wt-prov-cfg-"))
  cleanup.push(dir)
  const path = join(dir, "config.json")
  await writeFile(path, JSON.stringify({ worktrees: { root: join(dir, "root"), ...worktrees } }))
  return path
}

describe("the runtime and worktree packages agree on the default provisioning cap", () => {
  it("DEFAULT_WORKTREE_PROVISION_CONCURRENCY === DEFAULT_PROVISION_CONCURRENCY", () => {
    expect(DEFAULT_WORKTREE_PROVISION_CONCURRENCY).toBe(DEFAULT_PROVISION_CONCURRENCY)
    expect(WORKTREE_PROVISION_CONCURRENCY_ENV).toBe(PROVISION_CONCURRENCY_ENV)
  })
})

describe("makeWorktreeProvisioner and the provisioning queue", () => {
  it("applies worktrees.provisionConcurrency from config.json to the scheduler", { timeout: 20_000 }, async () => {
    const repoRoot = await makeRepo()
    const configPath = await makeConfig({ provisionConcurrency: 5 })
    const provision = makeWorktreeProvisioner(configPath)
    const out = await provision({ cwd: repoRoot, slug: "cfg-applied", base: "main" })
    expect(out.isolated).toBe(true)
    expect(provisionScheduler.snapshot().limit).toBe(5)
  })

  it("the env var wins over config.json", { timeout: 20_000 }, async () => {
    const repoRoot = await makeRepo()
    const configPath = await makeConfig({ provisionConcurrency: 5 })
    process.env[PROVISION_CONCURRENCY_ENV] = "1"
    await makeWorktreeProvisioner(configPath)({ cwd: repoRoot, slug: "env-wins", base: "main" })
    expect(provisionScheduler.snapshot().limit).toBe(1)
  })

  it("an unreadable config falls back to the default cap instead of failing provisioning", { timeout: 20_000 }, async () => {
    const repoRoot = await makeRepo()
    const dir = await mkdtemp(join(tmpdir(), "wt-prov-badcfg-"))
    cleanup.push(dir)
    const configPath = join(dir, "config.json")
    await writeFile(configPath, "{ not json")
    process.env["AGENTPROTO_WORKTREES_ROOT"] = join(dir, "root")
    const out = await makeWorktreeProvisioner(configPath)({ cwd: repoRoot, slug: "bad-cfg", base: "main" })
    expect(out.isolated).toBe(true)
    expect(provisionScheduler.snapshot().limit).toBe(DEFAULT_PROVISION_CONCURRENCY)
  })

  it("an already-aborted signal rejects with ProvisionCancelledError and never runs the setup hook", { timeout: 20_000 }, async () => {
    const repoRoot = await makeRepo()
    // A committed setup hook gives the provisioning a heavy phase to gate.
    await writeFile(join(repoRoot, "agentproto.json"), JSON.stringify({ worktree: { setup: "touch hook-ran" } }))
    git(repoRoot, "add", ".")
    git(repoRoot, "commit", "-q", "-m", "hook")
    const configPath = await makeConfig({})
    const ac = new AbortController()
    ac.abort()
    const progress: WorktreeProvisionProgress[] = []
    await expect(
      makeWorktreeProvisioner(configPath)({
        cwd: repoRoot,
        slug: "aborted",
        base: "main",
        signal: ac.signal,
        onProgress: p => progress.push(p),
      }),
    ).rejects.toBeInstanceOf(ProvisionCancelledError)
    expect(progress.at(-1)).toEqual({ kind: "done", outcome: "cancelled" })
    expect(provisionScheduler.snapshot()).toMatchObject({ running: 0, queued: 0 })
  })

  it("forwards progress reports to the caller's onProgress", { timeout: 20_000 }, async () => {
    const repoRoot = await makeRepo()
    const configPath = await makeConfig({})
    const progress: WorktreeProvisionProgress[] = []
    await makeWorktreeProvisioner(configPath)({ cwd: repoRoot, slug: "progress", base: "main", onProgress: p => progress.push(p) })
    expect(progress.at(-1)).toEqual({ kind: "done", outcome: "ok" })
  })
})

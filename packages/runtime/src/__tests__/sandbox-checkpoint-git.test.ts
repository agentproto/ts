/**
 * The checkpoint round trip against REAL git, with a local bare repo standing
 * in for `origin` and `sh -c` standing in for the box's `exec`: a box with
 * commits AND uncommitted work checkpoints it, dies, and a fresh checkout of
 * the same branch (the restart-on-a-new-box path) resumes both. The unit tests
 * fake the box; this one proves the generated shell actually does the job.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { execFile } from "node:child_process"
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import type { SandboxExecOpts, SandboxExecResult } from "@agentproto/sandbox"

import { checkpointBranchOf, runSandboxDelivery, type SandboxDeliveryTarget } from "../sandbox-delivery.js"
import {
  planSandboxWorkspace,
  runSandboxWorkspaceSetup,
  type CheckpointRestoreSnapshot,
} from "../sandbox-workspace-remote.js"

const run = promisify(execFile)

/** `GIT_CONFIG_GLOBAL` points at a per-test file (the setup's git-identity
 *  step writes `--global` config): never the developer's own. */
const GIT_ENV: Record<string, string> = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
  GIT_CONFIG_NOSYSTEM: "1",
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run("git", args, { cwd, env: { ...process.env, ...GIT_ENV } })
  return stdout.trim()
}

/** The box's `exec` seam, run on this machine. */
async function shExec(opts: SandboxExecOpts): Promise<SandboxExecResult> {
  const started = Date.now()
  try {
    const { stdout, stderr } = await run("sh", ["-c", opts.command], {
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      env: { ...process.env, ...GIT_ENV, ...opts.env },
      timeout: opts.timeoutMs,
    })
    return { exitCode: 0, stdout, stderr, durationMs: Date.now() - started }
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string }
    return {
      exitCode: typeof e.code === "number" ? e.code : 1,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? String(err),
      durationMs: Date.now() - started,
    }
  }
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  )
}

describe("checkpoint round trip (real git)", () => {
  let root: string
  let remote: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "agentproto-checkpoint-git-"))
    remote = join(root, "remote.git")
    GIT_ENV.GIT_CONFIG_GLOBAL = join(root, "gitconfig")
    await writeFile(GIT_ENV.GIT_CONFIG_GLOBAL, "")
    const seed = join(root, "seed")
    await git(root, "init", "-q", "--bare", "-b", "main", remote)
    await git(root, "init", "-q", "-b", "main", seed)
    await writeFile(join(seed, "README.md"), "seed\n")
    await writeFile(join(seed, ".gitignore"), "node_modules/\n")
    await git(seed, "add", "-A")
    await git(seed, "commit", "-m", "seed")
    await git(seed, "push", remote, "main")
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  })

  async function checkout(home: string, slug: string, checkpointSnapshot?: CheckpointRestoreSnapshot) {
    await mkdir(home, { recursive: true })
    const plan = planSandboxWorkspace({
      workspaceSlug: "repo",
      remote: { url: remote },
      homeDir: home,
      worktree: { slug },
      mintSlug: () => "unused",
      ...(checkpointSnapshot ? { checkpointSnapshot } : {}),
    })
    const result = await runSandboxWorkspaceSetup(shExec, plan)
    if (!result.ok) throw new Error(`${result.step}: ${result.message}`)
    return { plan, baseSha: result.baseSha }
  }

  it("delivers commits and uncommitted work from a dead box into a fresh one", async () => {
    // Box 1: cut the branch, commit once, then leave uncommitted work behind.
    const box1 = join(root, "box1")
    const { plan, baseSha } = await checkout(box1, "feature")
    const dir = plan.checkoutDir
    await writeFile(join(dir, "committed.txt"), "committed\n")
    await git(dir, "add", "-A")
    await git(dir, "commit", "-m", "work")
    await writeFile(join(dir, "README.md"), "edited, not committed\n")
    await writeFile(join(dir, "new-file.txt"), "untracked\n")
    await git(dir, "rm", "-q", "--cached", "committed.txt")
    await writeFile(join(dir, "staged.txt"), "staged\n")
    await git(dir, "add", "staged.txt")
    const indexBefore = await git(dir, "diff", "--cached", "--name-status")
    await mkdir(join(dir, "node_modules"))
    await writeFile(join(dir, "node_modules", "junk.js"), "ignored\n")

    const target: SandboxDeliveryTarget = { checkoutDir: dir, branch: "wt/feature", baseSha }
    const record = await runSandboxDelivery({
      exec: shExec,
      target,
      outDir: join(root, "host-out"),
      mode: "checkpoint",
    })

    expect(record.ahead).toBe(1)
    expect(record.push.status).toBe("pushed")
    expect(record.checkpoint).toMatchObject({ status: "pushed", ref: checkpointBranchOf("wt/feature") })
    // The agent's own index is untouched by the snapshot.
    expect(await git(dir, "diff", "--cached", "--name-status")).toBe(indexBefore)
    expect(await git(dir, "rev-parse", "--abbrev-ref", "HEAD")).toBe("wt/feature")

    // A second checkpoint with nothing new is a no-op.
    const again = await runSandboxDelivery({
      exec: shExec,
      target,
      outDir: join(root, "host-out"),
      mode: "checkpoint",
      ...(record.key ? { previousKey: record.key } : {}),
    })
    expect(again.unchanged).toBe(true)

    // Box 1 dies. Box 2 checks the same branch out from the remote.
    const box2 = join(root, "box2")
    const resumed = await checkout(box2, "feature")
    const dir2 = resumed.plan.checkoutDir
    expect(await git(dir2, "rev-parse", "HEAD")).toBe(await git(dir, "rev-parse", "HEAD"))
    expect(await readFile(join(dir2, "README.md"), "utf8")).toBe("edited, not committed\n")
    expect(await readFile(join(dir2, "new-file.txt"), "utf8")).toBe("untracked\n")
    expect(await readFile(join(dir2, "staged.txt"), "utf8")).toBe("staged\n")
    // Restored as uncommitted changes, ignored files never shipped.
    expect(await git(dir2, "status", "--porcelain")).not.toBe("")
    expect(await exists(join(dir2, "node_modules", "junk.js"))).toBe(false)
    expect(await git(dir2, "rev-parse", "--abbrev-ref", "@{upstream}")).toBe("origin/wt/feature")
  })

  it("ignores a stale checkpoint whose parent is not the branch tip", async () => {
    const box1 = join(root, "box1")
    const { plan, baseSha } = await checkout(box1, "stale")
    const dir = plan.checkoutDir
    await writeFile(join(dir, "draft.txt"), "draft\n")
    const target: SandboxDeliveryTarget = { checkoutDir: dir, branch: "wt/stale", baseSha }
    await runSandboxDelivery({ exec: shExec, target, outDir: join(root, "out"), mode: "checkpoint" })
    // The work is then committed and pushed: the snapshot is now behind.
    await git(dir, "add", "-A")
    await git(dir, "commit", "-m", "draft")
    await runSandboxDelivery({ exec: shExec, target, outDir: join(root, "out") })

    const box2 = join(root, "box2")
    const resumed = await checkout(box2, "stale")
    expect(await git(resumed.plan.checkoutDir, "status", "--porcelain")).toBe("")
    expect(await readFile(join(resumed.plan.checkoutDir, "draft.txt"), "utf8")).toBe("draft\n")
  })

  it("cuts a fresh branch when nothing was ever pushed", async () => {
    const { plan, baseSha } = await checkout(join(root, "box"), "fresh")
    expect(await git(plan.checkoutDir, "rev-parse", "HEAD")).toBe(baseSha)
    expect(await git(plan.checkoutDir, "rev-parse", "--abbrev-ref", "HEAD")).toBe("wt/fresh")
  })

  describe("migrate restore modes", () => {
    async function dirtyBox(slug: string, opts: { commit?: boolean } = {}) {
      const { plan, baseSha } = await checkout(join(root, `${slug}-box1`), slug)
      const dir = plan.checkoutDir
      if (opts.commit) {
        await writeFile(join(dir, "committed.txt"), "committed\n")
        await git(dir, "add", "-A")
        await git(dir, "commit", "-m", "work")
      }
      await writeFile(join(dir, "wip.txt"), "wip\n")
      const target: SandboxDeliveryTarget = { checkoutDir: dir, branch: `wt/${slug}`, baseSha }
      const record = await runSandboxDelivery({ exec: shExec, target, outDir: join(root, "out"), mode: "checkpoint" })
      return { dir, target, record }
    }

    it("restores exactly the snapshot a final checkpoint pushed: commits stay commits, the rest is uncommitted", async () => {
      const { dir, record } = await dirtyBox("exact", { commit: true })
      const sha = record.checkpoint?.sha
      expect(sha).toMatch(/^[0-9a-f]{40}/)
      const resumed = await checkout(join(root, "exact-box2"), "exact", { sha: sha as string })
      const dir2 = resumed.plan.checkoutDir
      expect(await git(dir2, "rev-parse", "HEAD")).toBe(await git(dir, "rev-parse", "HEAD"))
      expect(await readFile(join(dir2, "wip.txt"), "utf8")).toBe("wip\n")
      expect(await git(dir2, "status", "--porcelain")).toContain("wip.txt")
      expect(await git(dir2, "status", "--porcelain")).not.toContain("committed.txt")
    })

    it("skips a snapshot whose sha is not the one asked for", async () => {
      const { record } = await dirtyBox("wrongsha", { commit: true })
      expect(record.checkpoint?.sha).toBeDefined()
      const resumed = await checkout(join(root, "wrongsha-box2"), "wrongsha", { sha: "c".repeat(40) })
      expect(await git(resumed.plan.checkoutDir, "status", "--porcelain")).toBe("")
      expect(await exists(join(resumed.plan.checkoutDir, "wip.txt"))).toBe(false)
    })

    it('does not restore a stale snapshot in "none" mode', async () => {
      await dirtyBox("none", { commit: true })
      const resumed = await checkout(join(root, "none-box2"), "none", "none")
      expect(await git(resumed.plan.checkoutDir, "status", "--porcelain")).toBe("")
      expect(await exists(join(resumed.plan.checkoutDir, "wip.txt"))).toBe(false)
    })

    it("fast-forwards a work-branch tip the old box never pushed to the snapshot's parent", async () => {
      // Only the snapshot ref reached the remote: the branch itself stays at the base.
      const { dir, record } = await dirtyBox("ff", { commit: true })
      await git(dir, "push", "-q", "origin", "--delete", "wt/ff")
      const resumed = await checkout(join(root, "ff-box2"), "ff", { sha: record.checkpoint?.sha as string })
      const dir2 = resumed.plan.checkoutDir
      expect(await git(dir2, "rev-parse", "HEAD")).toBe(await git(dir, "rev-parse", "HEAD"))
      expect(await readFile(join(dir2, "wip.txt"), "utf8")).toBe("wip\n")
    })

    it("never clobbers a dirty tree", async () => {
      const { record } = await dirtyBox("dirty")
      const home = join(root, "dirty-box2")
      const first = await checkout(home, "dirty")
      await writeFile(join(first.plan.checkoutDir, "mine.txt"), "mine\n")
      // A second setup in the same (reused) box finds local edits and leaves them be.
      const again = await checkout(home, "dirty", { sha: record.checkpoint?.sha as string })
      expect(await readFile(join(again.plan.checkoutDir, "mine.txt"), "utf8")).toBe("mine\n")
    })
  })
})

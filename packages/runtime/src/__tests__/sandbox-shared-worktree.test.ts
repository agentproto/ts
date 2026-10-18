/**
 * AIP-36 per-session worktrees on a SHARED box: a session attaching to a box
 * other sessions may be using checks its repo out into its OWN git worktree
 * of the shared per-workspace clone, instead of re-checking that clone out on
 * its own branch (the old behaviour switched the branch out from under the
 * other sessions and mixed their uncommitted files). Covers the pure planner
 * (alone vs attach) and a REAL git two-session flow in a temp dir: different
 * branches, isolated commits, worktree removal on detach that keeps any
 * unpushed/undone work.
 */

import { execFileSync } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"
import type { SandboxExecOpts, SandboxExecResult } from "@agentproto/sandbox"

import {
  buildWorktreeRemoveCommand,
  planSandboxWorkspace,
  runSandboxWorkspaceSetup,
  type SandboxWorkspaceRequest,
} from "../sandbox-workspace-remote.js"

const request: SandboxWorkspaceRequest = {
  workspaceSlug: "agentproto",
  remote: { url: "https://github.com/acme/agentproto.git", credentialRef: "agentproto.git.acme" },
  homeDir: "/home/user",
  mintSlug: () => "minted01",
}

describe("planSandboxWorkspace — attach vs alone", () => {
  it("a session alone on a fresh box keeps the plain per-workspace checkout", () => {
    const plan = planSandboxWorkspace({ ...request, worktree: { slug: "x" } })
    expect(plan.checkoutDir).toBe("/home/user/agentproto")
    expect(plan.sharedBox).toBeUndefined()
    expect(plan.steps.map(s => s.label)).toEqual([
      "git-identity",
      "git-credential-helper",
      "git-clone",
      "resolve-base",
      "git-checkout",
      "restore-checkpoint",
    ])
    const checkout = plan.steps.find(s => s.label === "git-checkout")
    expect(checkout?.command).toContain("git checkout -b 'wt/x' 'origin/main'")
    expect(JSON.stringify(plan.steps)).not.toContain("worktree add")
    expect(JSON.stringify(plan.steps)).not.toContain("flock")
  })

  it("an attach gives the session its own worktree at .worktrees/<workspace>/<slug>", () => {
    const plan = planSandboxWorkspace({ ...request, worktree: { slug: "x" }, sharedBox: true })
    expect(plan.checkoutDir).toBe("/home/user/.worktrees/agentproto/x")
    expect(plan.sharedBox).toEqual({
      baseDir: "/home/user/agentproto",
      lockPath: "/home/user/.worktrees/agentproto.lock",
    })
    const add = plan.steps.find(s => s.label === "worktree-add")
    const command = add?.command ?? ""
    // Serialized on the shared clone
    expect(command).toContain("flock 9")
    expect(command).toContain("'/home/user/.worktrees/agentproto.lock'")
    // Same branch precedence as the solo step, resolved against the SHARED clone
    expect(command).toContain("show-ref --verify --quiet 'refs/heads/wt/x'")
    expect(command).toContain("worktree add '/home/user/.worktrees/agentproto/x' 'wt/x'")
    expect(command).toContain("worktree add --track -b 'wt/x' '/home/user/.worktrees/agentproto/x' 'origin/wt/x'")
    expect(command).toContain("worktree add -b 'wt/x' '/home/user/.worktrees/agentproto/x' 'origin/main'")
    // The base clone's checkout is never re-pointed at a session branch
    expect(command.includes(`/home/user/agentproto' checkout 'wt/x'`)).toBe(false)
    expect(command).toContain("checkout --detach")
    // The session starts IN the worktree (cwd + restore run there)
    expect(command).toContain("'/home/user/.worktrees/agentproto/x'")
    const restore = plan.steps.find(s => s.label === "restore-checkpoint")
    expect(restore?.command).toContain("'/home/user/.worktrees/agentproto/x'")
  })

  it("an attach reuses an existing worktree of the same branch", () => {
    const plan = planSandboxWorkspace({ ...request, worktree: { slug: "x" }, sharedBox: true })
    const add = plan.steps.find(s => s.label === "worktree-add")!.command
    expect(add).toContain(
      "if [ -e '/home/user/.worktrees/agentproto/x'/.git ]; then " +
        "git -C '/home/user/.worktrees/agentproto/x' checkout 'wt/x'",
    )
  })

  it("the fetch of the shared clone is lock-serialized; the clone itself is not", () => {
    const plan = planSandboxWorkspace({ ...request, worktree: { slug: "x" }, sharedBox: true })
    const clone = plan.steps.find(s => s.label === "git-clone")!.command
    expect(clone).toContain("if [ -d '/home/user/agentproto/.git' ]; then")
    expect(clone).toContain("flock 9")
    expect(clone).toContain("git -C '/home/user/agentproto' fetch --prune origin")
    expect(clone).toContain("git clone -- 'https://github.com/acme/agentproto.git' '/home/user/agentproto'")
  })

  it("worktree: false on an attach keeps the base clone's checkout (no per-session worktree)", () => {
    const plan = planSandboxWorkspace({ ...request, worktree: false, sharedBox: true })
    expect(plan.checkoutDir).toBe("/home/user/agentproto")
    expect(plan.sharedBox).toBeUndefined()
    expect(plan.steps.some(s => s.label === "worktree-add")).toBe(false)
  })
})

describe("buildWorktreeRemoveCommand", () => {
  it("removes only a clean, fully-pushed worktree and says so otherwise; locked on the shared clone", () => {
    const removed = buildWorktreeRemoveCommand({
      baseDir: "/home/user/agentproto",
      worktreeDir: "/home/user/.worktrees/agentproto/x",
      branch: "wt/x",
      lockPath: "/home/user/.worktrees/agentproto.lock",
    })
    expect(removed).toContain("flock 9")
    expect(removed).toContain("git -C '/home/user/.worktrees/agentproto/x' status --porcelain")
    expect(removed).toContain("rev-list --count 'refs/remotes/origin/wt/x..wt/x' 2>/dev/null || echo 1")
    expect(removed).toContain("git worktree remove '/home/user/.worktrees/agentproto/x'")
    expect(removed).toContain("worktree kept: uncommitted or unpushed work")
  })
})

describe("two sessions on one shared box — real git", () => {
  let home: string
  let originDir: string

  afterEach(async () => {
    if (home) await rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
    home = undefined as unknown as string
  })

  const env = (dir: string): { cwd: string; env: Record<string, string> } => ({
    cwd: dir,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  })

  const git = (args: string[], dir: string): string =>
    execFileSync("git", args, { ...env(dir), encoding: "utf8" }).trim()

  const exec = async (opts: SandboxExecOpts): Promise<SandboxExecResult> => {
    const command = opts.command ?? "true"
    try {
      const stdout = execFileSync("bash", ["-c", command], {
        ...env(opts.cwd ?? home ?? tmpdir()),
        encoding: "utf8",
        timeout: (opts.timeoutMs ?? 60_000) + 5_000,
      })
      return { exitCode: 0, stdout, stderr: "", durationMs: 1 }
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; status?: number }
      return { exitCode: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "", durationMs: 1 }
    }
  }

  const seedOrigin = (): string => {
    originDir = join(home, "origin")
    execFileSync("git", ["init", "--bare", "--initial-branch=main", originDir])
    const seed = join(home, "seed")
    execFileSync("git", ["clone", originDir, seed])
    git(["config", "user.email", "t@t.invalid"], seed)
    git(["config", "user.name", "seed"], seed)
    execFileSync("git", ["commit", "--allow-empty", "-m", "seed"], env(seed))
    execFileSync("bash", ["-c", "echo hello > README.md && git add README.md && git commit -qm 'seed readmes'"], env(seed))
    execFileSync("git", ["push", "-q", "origin", "HEAD:refs/heads/main"], env(seed))
    return originDir
  }

  /** Run the planned setup through REAL shell+git. `first` boots the box
   *  (plain checkout); the second session attaches with sharedBox: true. */
  const setup = async (slug: string, first: boolean): Promise<string> => {
    const plan = planSandboxWorkspace({
      ...request,
      remote: { url: originDir },
      homeDir: home,
      worktree: { slug },
      ...(first ? {} : { sharedBox: true }),
    })
    const result = await runSandboxWorkspaceSetup(exec, plan)
    if (!result.ok) throw new Error(`setup failed at ${result.step}: ${result.message}`)
    return plan.checkoutDir
  }

  const configIdentity = (dir: string): void => {
    git(["config", "user.email", "t@t.invalid"], dir)
    git(["config", "user.name", "agentproto"], dir)
  }

  it("each session works in its own worktree on its own branch and never sees the other's files", async () => {
    home = await mkdtemp(join(tmpdir(), "agentproto-shared-wt-"))
    seedOrigin()

    const dirA = await setup("a", true)
    expect(dirA).toBe(join(home, "agentproto"))
    const dirB = await setup("b", false)
    expect(dirB).toBe(join(home, ".worktrees", "agentproto", "b"))
    for (const dir of [dirA, dirB]) expect(readFileSync(join(dir, "README.md"), "utf8")).toBe("hello\n")

    // B's attach did not re-check out wt/a in the shared clone: that branch is
    // still A's, and the shared clone's scratch HEAD is detached.
    expect(git(["rev-parse", "--abbrev-ref", "HEAD"], dirA)).toBe("wt/a")
    expect(git(["rev-parse", "--abbrev-ref", "HEAD"], dirB)).toBe("wt/b")

    // Isolation: each commits a file the other never sees.
    configIdentity(dirA)
    configIdentity(dirB)
    execFileSync("bash", ["-c", "echo a > a-only.txt && git add a-only.txt && git commit -qm 'a work'"], env(dirA))
    execFileSync("bash", ["-c", "echo b > b-only.txt && git add b-only.txt && git commit -qm 'b work'"], env(dirB))
    expect(() => readFileSync(join(dirB, "a-only.txt"))).toThrow()
    expect(() => readFileSync(join(dirA, "b-only.txt"))).toThrow()

    // The second session's branch was cut from origin/main, not from wt/a —
    // and no branch survives the other's work apart from its own.
    expect(git(["branch", "--format=%(refname:short)", "--all"], join(home, "agentproto")).includes("wt/a")).toBe(true)
    expect(git(["branch", "--format=%(refname:short)", "--all"], dirB).includes("wt/b")).toBe(true)
  })

  it("reusing a local branch the base clone does not sit on never detaches the base's live checkout", async () => {
    home = await mkdtemp(join(tmpdir(), "agentproto-shared-wt-"))
    seedOrigin()

    // A (first session) is live in the base clone, checked out on wt/a, with
    // uncommitted-to-nothing commits landing on wt/a. A prior session left a
    // local wt/b branch behind (not checked out anywhere).
    const dirA = await setup("a", true)
    expect(dirA).toBe(join(home, "agentproto"))
    configIdentity(dirA)
    execFileSync("bash", ["-c", "echo a > a-only.txt && git add a-only.txt && git commit -qm 'a work'"], env(dirA))
    git(["branch", "wt/b", "origin/main"], dirA)

    // B attaches and reuses the still-present local branch wt/b.
    const dirB = await setup("b", false)
    expect(dirB).toBe(join(home, ".worktrees", "agentproto", "b"))
    expect(git(["rev-parse", "--abbrev-ref", "HEAD"], dirB)).toBe("wt/b")

    // The base clone's HEAD was never detached: A is still on wt/a...
    expect(git(["rev-parse", "--abbrev-ref", "HEAD"], dirA)).toBe("wt/a")
    // ...so a commit there lands on wt/a and survives delivery push.
    execFileSync("bash", ["-c", "echo more >> a-only.txt && git add a-only.txt && git commit -qm 'a more'"], env(dirA))
    expect(git(["rev-parse", "HEAD"], dirA)).toBe(git(["rev-parse", "wt/a"], join(home, "agentproto")))
    execFileSync("git", ["push", "-q", "origin", "wt/a"], env(dirA))
    expect(git(["rev-parse", "origin/wt/a"], join(home, "agentproto"))).toBe(git(["rev-parse", "wt/a"], dirA))
  })

  it("detaching the first session removes only its clean, pushed worktree; the second stays intact", async () => {
    home = await mkdtemp(join(tmpdir(), "agentproto-shared-wt-"))
    seedOrigin()

    const dirA = await setup("a", true)
    const dirB = await setup("b", false)
    configIdentity(dirA)
    configIdentity(dirB)
    execFileSync("bash", ["-c", "echo a > a-only.txt && git add . && git commit -qm 'a work'"], env(dirA))
    execFileSync("bash", ["-c", "echo b > b-only.txt && git add . && git commit -qm 'b work'"], env(dirB))

    // B (the attach) detaches: the teardown delivery first pushes its branch;
    // only THEN is ITS worktree removed. A's checkout of the shared clone is
    // untouched and keeps working (more commits still land in it).
    git(["push", "-q", "origin", "wt/b"], dirB)
    const removeB = execFileSync(
      "bash",
      [
        "-c",
        buildWorktreeRemoveCommand({
          baseDir: dirA,
          worktreeDir: dirB,
          branch: "wt/b",
          lockPath: join(home, ".worktrees", "agentproto.lock"),
        }),
      ],
      env(home),
    ).toString()
    expect(removeB).toContain("worktree removed")
    const alive = execFileSync("bash", ["-c", `test -e ${dirB}/.git; echo $?`], env(home)).toString().trim()
    expect(alive).toBe("1")
    expect(readFileSync(join(dirA, "a-only.txt"), "utf8")).toBe("a\n")
    execFileSync("bash", ["-c", "echo more > a-more.txt && git add . && git commit -qm 'a more'"], env(dirA))
    expect(readFileSync(join(dirA, "a-more.txt"), "utf8")).toBe("more\n")
  })

  it("detach never removes a worktree with uncommitted or unpushed work", async () => {
    home = await mkdtemp(join(tmpdir(), "agentproto-shared-wt-"))
    seedOrigin()

    await setup("a", true)
    const dirB = await setup("b", false)
    configIdentity(dirB)
    execFileSync("bash", ["-c", "echo dirty > dirty.txt && git add dirty.txt && git commit -qm 'unpushed commit'"], env(dirB))
    execFileSync("bash", ["-c", "echo uncommitted >> dirty.txt"], env(dirB))

    const removal = execFileSync(
      "bash",
      [
        "-c",
        buildWorktreeRemoveCommand({
          baseDir: join(home, "agentproto"),
          worktreeDir: dirB,
          branch: "wt/b",
          lockPath: join(home, ".worktrees", "agentproto.lock"),
        }),
      ],
      env(home),
    ).toString()
    expect(removal).toContain("worktree kept")
    expect(readFileSync(join(dirB, "dirty.txt"), "utf8")).toContain("uncommitted")
    expect(git(["worktree", "list", "--porcelain"], join(home, "agentproto"))).toContain(dirB)
  })
})

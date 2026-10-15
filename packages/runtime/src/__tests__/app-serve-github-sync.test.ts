/**
 * A2 — github workspace sync over the sandbox appServe path: the app's
 * `storage: github` `pull-push` declaration (read from its in-box
 * WORKSPACE.md) is pulled present + up to date after `app_install` (via
 * `createGithubWorkspaceSync`'s pull contract, run through an exec seam),
 * and the OPT-IN close-time push (branch + PR only) rides
 * `onBeforeTeardown`. Real git against a local bare origin — no network.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises"
import { existsSync, realpathSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SandboxExec } from "../sandbox-workspace-remote.js"
import type { BranchPolicy as BranchHint, PrPolicy as PrHint } from "@agentproto/storage-github"
import {
  composeTeardownHooks,
  createGithubWorkspacePushAtClose,
  pullAppGithubWorkspace,
  readAppGithubWorkspaceSync,
  type AppGithubWorkspaceSync,
} from "../sandbox-app-serve.js"

const REPO_URL = "https://github.com/acme/pygmalion-home"

function git(args: string[], cwd: string): string {
  const res = spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
  if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`)
  return res.stdout.trim()
}

function gitAll(args: string[], cwd: string): string {
  return spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).stdout.trim()
}

async function makeBareOrigin(base: string): Promise<string> {
  const origin = join(base, "origin.git")
  git(["init", "--bare", "-b", "main", origin], base)
  const seed = join(base, "seed")
  await mkdir(seed, { recursive: true })
  git(["init", "-b", "main", "."], seed)
  git(["config", "user.name", "Seeder"], seed)
  git(["config", "user.email", "seeder@example.com"], seed)
  await writeFile(join(seed, "README.md"), "# home\n")
  git(["add", "-A"], seed)
  git(["commit", "-m", "initial"], seed)
  git(["remote", "add", "origin", origin], seed)
  git(["push", "-u", "origin", "main"], seed)
  return origin
}

/** The token must never touch a command line: every exec command string is
 *  scanned for the raw token. */
function localExec(base: string, forbidden?: string): SandboxExec {
  return async ({ command, cwd, env }) => {
    const res = spawnSync("sh", ["-c", command], {
      cwd: cwd ?? base,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: env ? { ...process.env, ...env } : process.env,
    })
    const stdout = res.stdout ?? ""
    if (forbidden !== undefined) {
      expect(command, "the token leaked onto the command line").not.toContain(forbidden)
      expect(stdout, "the token leaked to stdout").not.toContain(forbidden)
    }
    return { exitCode: res.status ?? -1, stdout, stderr: res.stderr ?? "", durationMs: 1 }
  }
}

function workspaceMd(mountPath: string, push?: { branch: string; pr: string } | "main"): string {
  const pushYaml =
    push === undefined
      ? ""
      : push === "main"
        ? "      push: { branch_policy: main }\n"
        : `      push: { branch_policy: ${push.branch}, pr_policy: ${push.pr} }\n`
  return (
    "---\n" +
    'schema: "workspace/v1"\n' +
    'id: "@acme/home"\n' +
    'version: "1.0.0"\n' +
    "name: Home\n" +
    'owner: { type: "org", id: "org_1", slug: acme }\n' +
    "storage:\n" +
    "  inline:\n" +
    "    provider: github\n" +
    `    config: { repo_url: "${REPO_URL}", mount_path: "${mountPath}" }\n` +
    "    sync:\n" +
    "      mode: pull-push\n" +
    pushYaml +
    "---\n"
  )
}

function syncOf(decl: AppGithubWorkspaceSync): AppGithubWorkspaceSync {
  return decl
}

describe("readAppGithubWorkspaceSync", () => {
  let base: string
  let appDir: string
  beforeEach(async () => {
    base = realpathSync(await mkdtemp(join(tmpdir(), "appserve-sync-")))
    appDir = join(base, "app")
    await mkdir(appDir, { recursive: true })
  })
  afterEach(async () => {
    await rm(base, { recursive: true, force: true })
  })

  it("parses the app's WORKSPACE.md declaration", async () => {
    await writeFile(join(appDir, "WORKSPACE.md"), workspaceMd(join(base, "mount"), { branch: "per-conversation", pr: "manual" }))
    const sync = await readAppGithubWorkspaceSync(localExec(base), appDir)
    expect(sync?.dir).toBe(join(base, "mount"))
    expect(sync?.config).toEqual({ repoUrl: REPO_URL, branchPolicy: "per-conversation", prPolicy: "manual" })
    expect(sync?.tokenEnv).toEqual(["GITHUB_TOKEN", "GH_TOKEN"])
  })

  it.each([
    ["a missing WORKSPACE.md", undefined],
    ["a bogus declaration (no frontmatter)", "# no yaml\n"],
    ["another provider", "this is not the target repo url!\n---\nnoise\n"],
  ])("returns undefined for %s", async (_label, content) => {
    if (content !== undefined) await writeFile(join(appDir, "WORKSPACE.md"), content)
    expect(await readAppGithubWorkspaceSync(localExec(base), appDir)).toBeUndefined()
  })
})

describe("pullAppGithubWorkspace", () => {
  let base: string
  let origin: string
  const appDir = () => join(base, "app")
  let appDirPath: string
  let warn: ReturnType<typeof vi.spyOn>
  beforeEach(async () => {
    base = realpathSync(await mkdtemp(join(tmpdir(), "appserve-pull-")))
    origin = await makeBareOrigin(base)
    appDirPath = appDir()
    await mkdir(appDirPath, { recursive: true })
    warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  })
  afterEach(async () => {
    warn.mockRestore()
    await rm(base, { recursive: true, force: true })
  })

  const token = () => "test-token-not-real"
  const myDecl = (mount: string, push?: { branch: string; pr: string }): AppGithubWorkspaceSync => ({
    dir: mount,
    config: {
      repoUrl: REPO_URL,
      ...(push
        ? {
            branchPolicy: push.branch as BranchHint,
            prPolicy: push.pr as PrHint,
          }
        : {}),
    },
    tokenEnv: ["GITHUB_TOKEN", "GH_TOKEN"],
  })

  it("clones into an empty mount and scrubs the persisted auth header", async () => {
    const mount = join(base, "mount")
    const res = await pullAppGithubWorkspace(localExec(base, token()), myDecl(mount), {
      cloneUrl: origin,
      resolveToken: token,
    })
    expect(res.ok).toBe(true)
    expect(await readFile(join(mount, "README.md"), "utf8")).toBe(
      "# home\n",
    )
    const config = await readFile(join(mount, ".git", "config"), "utf8")
    expect(config).not.toContain("extraheader")
    expect(config).not.toContain(token())
  })

  it("refreshes an existing checkout from the origin", async () => {
    const mount = join(base, "existing")
    git(["clone", origin, mount], base)
    const seed = join(base, "pusher")
    git(["clone", origin, seed], base)
    git(["config", "user.name", "P"], seed)
    git(["config", "user.email", "p@example.com"], seed)
    await writeFile(join(seed, "docs.md"), "# newer upstream\n")
    git(["add", "-A"], seed)
    git(["commit", "-m", "update"], seed)
    git(["push", "origin", "main:main"], seed)
    const res = await pullAppGithubWorkspace(localExec(base, token()), myDecl(mount), {
      cloneUrl: origin,
      resolveToken: token,
    })
    expect(res.ok).toBe(true)
    expect(existsSync(join(mount, "docs.md"))).toBe(true)
  })

  it("refuses to clobber a diverged checkout (ff-only) and leaves it intact", async () => {
    const mount = join(base, "diverged")
    git(["clone", origin, mount], base)
    git(["config", "user.name", "L"], mount)
    git(["config", "user.email", "l@example.com"], mount)
    await writeFile(join(mount, "local.md"), "mine\n")
    git(["add", "-A"], mount)
    git(["commit", "-m", "local"], mount)
    const head = git(["rev-parse", "HEAD"], mount)
    git(["commit", "--allow-empty", "-m", "origin advance"], `${base}/seed`)
    git(["push", "origin", "main:main"], `${base}/seed`)
    const res = await pullAppGithubWorkspace(localExec(base, token()), myDecl(mount), {
      cloneUrl: origin,
      resolveToken: token,
    })
    expect(res.ok).toBe(false)
    expect(res).toHaveProperty("reason")
    expect(git(["rev-parse", "HEAD"], mount)).toBe(head)
    expect(existsSync(join(mount, "local.md"))).toBe(true)
  })

  it("fails fast without a token and leaves the mount empty-dir-less", async () => {
    const mount = join(base, "notoken")
    const res = await pullAppGithubWorkspace(localExec(base), myDecl(mount), {
      cloneUrl: origin,
      resolveToken: () => undefined,
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toContain("no GitHub token")
    expect(existsSync(join(mount, ".git"))).toBe(false)
  })

  it("a failed clone is reported, never thrown", async () => {
    const mount = join(base, "badorigin")
    const res = await pullAppGithubWorkspace(localExec(base, token()), myDecl(mount), {
      cloneUrl: join(base, "missing.git"),
      resolveToken: token,
    })
    expect(res.ok).toBe(false)
  })

  it("pull keeps the declared branch/pr policy and lands the checkout on main", async () => {
    const mount = join(base, "withpolicy")
    const decl = myDecl(mount, { branch: "per-conversation", pr: "manual" })
    const res = await pullAppGithubWorkspace(localExec(base, token()), decl, {
      cloneUrl: origin,
      resolveToken: token,
    })
    expect(res.ok).toBe(true)
    expect(gitAll(["rev-parse", "--abbrev-ref", "HEAD"], mount)).toBe("main")
    expect(syncOf(decl).config.branchPolicy).toBe("per-conversation")
  })
})

describe("createGithubWorkspacePushAtClose — opt-in decision", () => {
  let base: string
  let origin: string
  let warn: ReturnType<typeof vi.spyOn>
  beforeEach(async () => {
    base = realpathSync(await mkdtemp(join(tmpdir(), "appserve-push-")))
    origin = await makeBareOrigin(base)
    warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  })
  afterEach(async () => {
    warn.mockRestore()
    await rm(base, { recursive: true, force: true })
  })
  const token = () => "test-token-not-real"
  const exec = () => localExec(base, token())
  const decl = (
    mount: string,
    config: Omit<Partial<AppGithubWorkspaceSync["config"]>, "branchPolicy" | "prPolicy"> & {
      branchPolicy?: BranchHint
      prPolicy?: PrHint
    },
  ): AppGithubWorkspaceSync => ({
    dir: mount,
    config: { repoUrl: REPO_URL, ...config },
    tokenEnv: ["GITHUB_TOKEN"],
  })

  it("is undefined without an explicit non-main declaration + non-none pr_policy", () => {
    const mount = join(base, "noopt")
    expect(createGithubWorkspacePushAtClose({ sync: decl(mount, {}), exec: exec() })).toBeUndefined()
    expect(
      createGithubWorkspacePushAtClose({
        sync: decl(mount, { branchPolicy: "per-turn" }),
        exec: exec(),
      }),
    ).toBeUndefined()
    expect(
      createGithubWorkspacePushAtClose({
        sync: decl(mount, { branchPolicy: "per-conversation", prPolicy: "none" }),
        exec: exec(),
      }),
    ).toBeUndefined()
  })

  it("refuses an explicit main branch policy (never push the base branch)", () => {
    expect(
      createGithubWorkspacePushAtClose({
        sync: decl(join(base, "mainpol"), { branchPolicy: "main", prPolicy: "manual" }),
        exec: exec(),
      }),
    ).toBeUndefined()
  })

  it("is skipped when exec is absent (no exec seam to run git)", () => {
    expect(
      createGithubWorkspacePushAtClose({
        sync: decl(join(base, "noexec"), { branchPolicy: "per-turn", prPolicy: "manual" }),
      }),
    ).toBeUndefined()
  })

  it("pushes a per-conversation branch + manual PR guidance, never main", async () => {
    const mount = join(base, "mount")
    git(["clone", origin, mount], base)
    await writeFile(join(mount, "work.txt"), "session work\n")
    const hook = createGithubWorkspacePushAtClose({
      sync: decl(mount, { branchPolicy: "per-conversation", prPolicy: "manual" }),
      exec: exec(),
      sessionId: "sess_abc123",
      resolveToken: token,
      cloneUrl: origin,
    })
    expect(hook).toBeDefined()
    await hook?.()
    const originBranches = gitAll(["branch", "--format=%(refname:short)"], origin).split("\n")
    expect(originBranches).toContain("agentproto/sess_abc123")
    expect(originBranches).toEqual(expect.arrayContaining(["main", "agentproto/sess_abc123"]))
    expect(originBranches).toHaveLength(2)
    // the per-conversation branch carries the work
    // the per-conversation branch carries the work
    expect(gitAll(["show", "agentproto/sess_abc123:work.txt"], origin)).toBe("session work")
  })

  it("a per-turn policy falls back to a unique agentproto branch at close", async () => {
    const mount = join(base, "turnmount")
    git(["clone", origin, mount], base)
    await writeFile(join(mount, "t.txt"), "turn work\n")
    const hook = createGithubWorkspacePushAtClose({
      sync: decl(mount, { branchPolicy: "per-turn", prPolicy: "manual" }),
      exec: exec(),
      sessionId: "sess_turn",
      resolveToken: token,
      cloneUrl: origin,
    })
    await hook?.()
    const originBranches = gitAll(["branch", "--list", "agentproto/*"], origin)
    expect(originBranches.length).toBeGreaterThan(0)
    expect(originBranches).not.toContain("main")
  })

  it("a clean tree does not fail the close (no_changes)", async () => {
    const mount = join(base, "clean")
    git(["clone", origin, mount], base)
    const hook = createGithubWorkspacePushAtClose({
      sync: decl(mount, { branchPolicy: "per-conversation", prPolicy: "manual" }),
      exec: exec(),
      sessionId: "sess_clean",
      resolveToken: token,
      cloneUrl: origin,
    })
    await hook?.()
    expect(gitAll(["branch", "--list"], origin)).not.toContain("agentproto/sess_clean")
  })

  it("a missing token is warned, never thrown", async () => {
    const mount = join(base, "notokenmount")
    git(["clone", origin, mount], base)
    await writeFile(join(mount, "n.txt"), "x\n")
    const hook = createGithubWorkspacePushAtClose({
      sync: decl(mount, { branchPolicy: "per-conversation", prPolicy: "manual" }),
      exec: exec(),
      resolveToken: () => undefined,
      cloneUrl: origin,
    })
    await hook?.()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("no GitHub token"))
  })
})

describe("composeTeardownHooks", () => {
  it("returns undefined for an empty composition", () => {
    expect(composeTeardownHooks()).toBeUndefined()
    expect(composeTeardownHooks(undefined, undefined)).toBeUndefined()
  })

  it("a single hook is returned as-is", async () => {
    const a = vi.fn().mockResolvedValue(undefined)
    expect(composeTeardownHooks(a)).toBe(a)
  })

  it("runs each composed hook in order, both swallowing its own errors", async () => {
    const order: string[] = []
    const a = async () => {
      order.push("a")
    }
    const b = async () => {
      order.push("b")
    }
    const hook = composeTeardownHooks(a, b)
    await hook?.()
    expect(order).toEqual(["a", "b"])
  })
})

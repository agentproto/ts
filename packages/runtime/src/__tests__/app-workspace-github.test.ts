/**
 * Git-backed app workspaces: a WORKSPACE.md declaring `storage: github` +
 * `sync.mode: pull-push` is cloned (via storage-github's
 * `createGithubWorkspaceSync`) into its `mount_path`, which then becomes the
 * app's registered workspace path. Real git against a local bare origin — no
 * network (the clone URL is injected; the manifest can never set it).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir } from "node:fs/promises"
import { existsSync, realpathSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  appWorkspaceSlug,
  declaredGithubWorkspace,
  declaredWorkspaceHome,
  registerAppWorkspace,
} from "../app-workspace.js"
import { findWorkspace, loadWorkspacesConfig } from "../workspaces-config.js"
import { realGitRunner } from "@agentproto/storage-github"

const APP_ID = "@test/git-app"
const REPO_URL = "https://github.com/acme/pygmalion-home"

function git(args: string[], cwd: string): string {
  const res = spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
  if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`)
  return res.stdout.trim()
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

function workspaceDecl(mountPath: string, overrides: Record<string, unknown> = {}) {
  return {
    id: "@acme/home",
    name: "Home",
    owner: { type: "org", id: "org_1", slug: "acme" },
    storage: {
      inline: {
        provider: "github",
        config: { repo_url: REPO_URL, mount_path: mountPath },
        sync: { mode: "pull-push", push: { branch_policy: "per-conversation", pr_policy: "manual" } },
        ...overrides,
      },
    },
  }
}

describe("declaredGithubWorkspace", () => {
  it("parses a pull-push github declaration, spec snake_case and policies included", () => {
    const decl = declaredGithubWorkspace(
      workspaceDecl("/data/home", {
        config: { repo_url: REPO_URL, mount_path: "/data/home", base_branch: "trunk" },
        auth: { state: { env: ["PYGMALION_GH_TOKEN", "not a name!"] } },
      }),
    )
    expect(decl).toEqual({
      dir: "/data/home",
      config: { repoUrl: REPO_URL, baseBranch: "trunk", branchPolicy: "per-conversation", prPolicy: "manual" },
      tokenEnv: ["PYGMALION_GH_TOKEN"],
    })
  })

  it("defaults the token env to GITHUB_TOKEN / GH_TOKEN", () => {
    expect(declaredGithubWorkspace(workspaceDecl("/data/home"))?.tokenEnv).toEqual(["GITHUB_TOKEN", "GH_TOKEN"])
  })

  it.each([
    ["a non-pull-push sync mode", workspaceDecl("/h", { sync: { mode: "canonical" } })],
    ["no sync block", workspaceDecl("/h", { sync: undefined })],
    ["a non-github.com repo (token would leak)", workspaceDecl("/h", { config: { repo_url: "https://evil.example/a/b", mount_path: "/h" } })],
    ["an http repo url", workspaceDecl("/h", { config: { repo_url: "http://github.com/a/b", mount_path: "/h" } })],
    ["a relative mount_path", workspaceDecl("rel/path")],
    ["no mount_path", workspaceDecl("/h", { config: { repo_url: REPO_URL } })],
    ["another provider", workspaceDecl("/h", { provider: "local-fs" })],
  ])("rejects %s", (_label, ws) => {
    expect(declaredGithubWorkspace(ws)).toBeUndefined()
  })

  it("ignores undefined / ref-only workspaces", () => {
    expect(declaredGithubWorkspace(undefined)).toBeUndefined()
    expect(declaredGithubWorkspace({ storage: { ref: "x" } })).toBeUndefined()
  })

  it("drops an unknown branch_policy / pr_policy instead of casting it through", () => {
    const decl = declaredGithubWorkspace(
      workspaceDecl("/data/home", {
        sync: { mode: "pull-push", push: { branch_policy: "per_conversation", pr_policy: "sometimes" } },
      }),
    )
    expect(decl?.dir).toBe("/data/home")
    expect(decl?.config).toEqual({ repoUrl: REPO_URL })
    expect("branchPolicy" in (decl?.config ?? {})).toBe(false)
    expect("prPolicy" in (decl?.config ?? {})).toBe(false)
  })

  it("keeps a valid branch_policy / pr_policy", () => {
    const decl = declaredGithubWorkspace(
      workspaceDecl("/data/home", {
        sync: { mode: "pull-push", push: { branch_policy: "per-turn", pr_policy: "auto" } },
      }),
    )
    expect(decl?.config.branchPolicy).toBe("per-turn")
    expect(decl?.config.prPolicy).toBe("auto")
  })
})

describe("github-backed app workspace", () => {
  let base: string
  let origin: string
  let warn: ReturnType<typeof vi.spyOn>
  beforeEach(async () => {
    base = realpathSync(await mkdtemp(join(tmpdir(), "app-ws-github-")))
    origin = await makeBareOrigin(base)
    warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  })
  afterEach(async () => {
    warn.mockRestore()
    await rm(base, { recursive: true, force: true })
  })

  const token = () => "test-token-not-real"

  it("clones into a missing mount_path and returns it as the workspace home", async () => {
    const mount = join(base, "home")
    const home = await declaredWorkspaceHome(workspaceDecl(mount), { cloneUrl: origin, resolveToken: token })
    expect(home).toBe(mount)
    expect(await readFile(join(mount, "README.md"), "utf8")).toBe("# home\n")
    expect(existsSync(join(mount, ".git"))).toBe(true)
  })

  it("scrubs the persisted auth header from the clone's .git/config after a seed clone", async () => {
    const mount = join(base, "scrubbed")
    const home = await declaredWorkspaceHome(workspaceDecl(mount), { cloneUrl: origin, resolveToken: token })
    expect(home).toBe(mount)
    const config = await readFile(join(mount, ".git", "config"), "utf8")
    expect(config).not.toContain("extraheader")
    expect(config).not.toContain("x-access-token")
    expect(config).not.toContain(token())
    // the scrub did not break the checkout
    expect(git(["status", "--porcelain"], mount)).toBe("")
    expect(git(["rev-parse", "--abbrev-ref", "HEAD"], mount)).toBe("main")
  })

  it("leaves no directory behind when the declaration fails (no token)", async () => {
    const mount = join(base, "no-token-no-dir")
    const home = await declaredWorkspaceHome(workspaceDecl(mount), { cloneUrl: origin, resolveToken: () => undefined })
    expect(home).toBeUndefined()
    expect(existsSync(mount)).toBe(false)
  })

  it("clones into an existing empty directory", async () => {
    const mount = join(base, "empty")
    await mkdir(mount)
    expect(await declaredWorkspaceHome(workspaceDecl(mount), { cloneUrl: origin, resolveToken: token })).toBe(mount)
    expect(existsSync(join(mount, "README.md"))).toBe(true)
  })

  it("refuses a non-empty, non-git directory and leaves it untouched", async () => {
    const mount = join(base, "busy")
    await mkdir(mount)
    await writeFile(join(mount, "mine.txt"), "do not clobber")
    const home = await declaredWorkspaceHome(workspaceDecl(mount), { cloneUrl: origin, resolveToken: token })
    expect(home).toBeUndefined()
    expect(await readdir(mount)).toEqual(["mine.txt"])
    expect(await readFile(join(mount, "mine.txt"), "utf8")).toBe("do not clobber")
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("not empty"))
  })

  it("accepts an existing checkout as-is without touching the network or its local edits", async () => {
    const mount = join(base, "existing")
    git(["clone", origin, mount], base)
    await writeFile(join(mount, "wip.txt"), "uncommitted work")
    const home = await declaredWorkspaceHome(workspaceDecl(mount), {
      cloneUrl: join(base, "does-not-exist.git"),
      resolveToken: () => undefined,
    })
    expect(home).toBe(mount)
    expect(await readFile(join(mount, "wip.txt"), "utf8")).toBe("uncommitted work")
  })

  it("without a token it does not clone and falls back", async () => {
    const mount = join(base, "notoken")
    const home = await declaredWorkspaceHome(workspaceDecl(mount), { cloneUrl: origin, resolveToken: () => undefined })
    expect(home).toBeUndefined()
    expect(existsSync(join(mount, ".git"))).toBe(false)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("no GitHub token"))
  })

  it("a failed clone falls back instead of throwing and leaves no empty dir", async () => {
    const mount = join(base, "badorigin")
    const home = await declaredWorkspaceHome(workspaceDecl(mount), {
      cloneUrl: join(base, "missing.git"),
      resolveToken: token,
    })
    expect(home).toBeUndefined()
    // A2: the just-created empty dir is removed again — the failed
    // declaration leaves nothing behind.
    expect(existsSync(mount)).toBe(false)
  })

  it("warns when the persisted-auth scrub fails (self-checking guarantee)", async () => {
    const mount = join(base, "scrub-fail")
    const home = await declaredWorkspaceHome(workspaceDecl(mount), {
      cloneUrl: origin,
      resolveToken: token,
      gitRunner: (args, opts) => {
        // Fail ONLY the scrub call; everything else runs for real.
        if (args.some(a => a.includes("remove-section"))) {
          return { ok: false, stdout: "", stderr: "boom", status: 1 }
        }
        return realGitRunner(args, opts)
      },
    })
    expect(home).toBe(mount)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not scrub the persisted auth"))
  })

  it("registerAppWorkspace registers the clone as the app's workspace path", async () => {
    const mount = join(base, "registered")
    const appDir = join(base, "app")
    await mkdir(appDir)
    const configPath = join(base, "workspaces.json")
    const slug = await registerAppWorkspace({
      appId: APP_ID,
      dir: appDir,
      workspace: workspaceDecl(mount),
      configPath,
      github: { cloneUrl: origin, resolveToken: token },
    })
    expect(slug).toBe(appWorkspaceSlug(APP_ID))
    const ws = findWorkspace(await loadWorkspacesConfig(configPath), slug!)
    expect(ws?.path).toBe(mount)
    expect(ws?.ownerApp).toBe(APP_ID)
  })

  it("registerAppWorkspace falls back to the app dir when the clone is refused", async () => {
    const mount = join(base, "busy2")
    const appDir = join(base, "app2")
    await mkdir(mount)
    await mkdir(appDir)
    await writeFile(join(mount, "x"), "x")
    const configPath = join(base, "workspaces.json")
    const slug = await registerAppWorkspace({
      appId: APP_ID,
      dir: appDir,
      workspace: workspaceDecl(mount),
      configPath,
      github: { cloneUrl: origin, resolveToken: token },
    })
    expect(findWorkspace(await loadWorkspacesConfig(configPath), slug!)?.path).toBe(appDir)
  })
})

import { describe, it, expect, afterEach, vi } from "vitest"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir, homedir } from "node:os"
import { join, basename } from "node:path"
import { spawnSync } from "node:child_process"
import { realpathSync } from "node:fs"
import { runWorktree, resolveWorktreesRoot } from "../commands/worktree.js"
import { readWorktreeMarker } from "@agentproto/worktree"

const cleanupPaths: string[] = []

afterEach(async () => {
  delete process.env["AGENTPROTO_WORKTREES_ROOT"]
  for (const p of cleanupPaths.splice(0)) {
    await rm(p, { recursive: true, force: true }).catch(() => {})
  }
})

function git(cwd: string, ...args: string[]): void {
  const res = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" })
  if (res.status !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr}`)
}

async function makeRepo(): Promise<string> {
  // realpath so macOS /var → /private/var symlinking doesn't defeat equality.
  const root = realpathSync(await mkdtemp(join(tmpdir(), "wt-new-repo-")))
  cleanupPaths.push(root)
  git(root, "init", "-q", "-b", "main")
  git(root, "config", "user.email", "t@t.t")
  git(root, "config", "user.name", "t")
  await writeFile(join(root, "f"), "x")
  git(root, "add", ".")
  git(root, "commit", "-q", "-m", "init")
  return root
}

/** Capture stdout writes into an array. */
function captureStdout(): { chunks: string[]; restore: () => void } {
  const chunks: string[] = []
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk))
    return true
  })
  return { chunks, restore: () => spy.mockRestore() }
}

describe("resolveWorktreesRoot — flag > env > config.json > default (config.ts's resolution order)", () => {
  it("the --root flag wins over env, config, and the default", async () => {
    process.env["AGENTPROTO_WORKTREES_ROOT"] = "/env/root"
    expect(await resolveWorktreesRoot("/flag/root")).toBe(join("/flag/root"))
  })

  it("the env var wins over config.json and the default when no flag is given", async () => {
    process.env["AGENTPROTO_WORKTREES_ROOT"] = "/env/root"
    expect(await resolveWorktreesRoot(undefined)).toBe(join("/env/root"))
  })

  it("config.json's worktrees.root wins over the hardcoded default", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wt-new-cfg-"))
    cleanupPaths.push(dir)
    const configPath = join(dir, "config.json")
    await writeFile(configPath, JSON.stringify({ worktrees: { root: "/cfg/root" } }))
    expect(await resolveWorktreesRoot(undefined, configPath)).toBe(join("/cfg/root"))
  })

  it("falls back to ~/.agentproto/worktrees when nothing is set — a real root, not merely 'unconfigured'", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wt-new-cfg-"))
    cleanupPaths.push(dir)
    const configPath = join(dir, "missing-config.json")
    expect(await resolveWorktreesRoot(undefined, configPath)).toBe(join(homedir(), ".agentproto", "worktrees"))
  })
})

describe("agentproto worktree new", () => {
  it("creates <root>/<repoName>/<slug> on branch wt/<slug>, and writes the provenance marker", async () => {
    const repoRoot = await makeRepo()
    const root = await mkdtemp(join(tmpdir(), "wt-new-root-"))
    cleanupPaths.push(root)

    const out = captureStdout()
    let code: number
    try {
      code = await runWorktree(["new", "my-feature", "--repo", repoRoot, "--root", root, "--base", "main", "--json"])
    } finally {
      out.restore()
    }
    expect(code).toBe(0)

    const expectedDir = join(root, basename(repoRoot), "my-feature")
    const result = JSON.parse(out.chunks.join(""))
    expect(result).toEqual({ cwd: expectedDir, branch: "wt/my-feature" })

    const branchRes = spawnSync("git", ["-C", expectedDir, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" })
    expect(branchRes.stdout.trim()).toBe("wt/my-feature")

    const marker = await readWorktreeMarker(expectedDir)
    expect(marker).not.toBeNull()
    expect(marker?.worktreeId).toMatch(/^wt_/)
  })

  it("--branch overrides the default wt/<slug> branch naming", async () => {
    const repoRoot = await makeRepo()
    const root = await mkdtemp(join(tmpdir(), "wt-new-root-"))
    cleanupPaths.push(root)

    const out = captureStdout()
    let code: number
    try {
      code = await runWorktree([
        "new",
        "my-feature",
        "--repo",
        repoRoot,
        "--root",
        root,
        "--base",
        "main",
        "--branch",
        "feat/renamed",
        "--json",
      ])
    } finally {
      out.restore()
    }
    expect(code).toBe(0)
    const result = JSON.parse(out.chunks.join(""))
    expect(result.branch).toBe("feat/renamed")
  })

  it("fails with a usage error when the slug is missing", async () => {
    const repoRoot = await makeRepo()
    const code = await runWorktree(["new", "--repo", repoRoot])
    expect(code).toBe(2)
  })
})

import { describe, it, expect, afterEach } from "vitest"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { realpathSync } from "node:fs"
import { repoRootOf } from "../commands/worktree.js"

const cleanupPaths: string[] = []

afterEach(async () => {
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
  const root = realpathSync(await mkdtemp(join(tmpdir(), "wt-root-")))
  cleanupPaths.push(root)
  git(root, "init", "-q")
  git(root, "config", "user.email", "t@t.t")
  git(root, "config", "user.name", "t")
  await writeFile(join(root, "f"), "x")
  git(root, "add", ".")
  git(root, "commit", "-q", "-m", "init")
  return root
}

describe("repoRootOf", () => {
  // The regression: from a LINKED worktree, `git rev-parse --show-toplevel`
  // returns the worktree's OWN path, not the main repo — so archive teardown
  // then ran git with a cwd that vanished on removal (spawn ENOENT). The fix
  // resolves the MAIN repo via --git-common-dir, which must hold from inside a
  // linked worktree AND (relative-path trap) from a subdirectory of the main.
  it("returns the MAIN repo root from inside a linked worktree", async () => {
    const root = await makeRepo()
    const wt = join(root, "_wt", "feature")
    git(root, "worktree", "add", "-q", wt, "-b", "feature")

    // The whole point: NOT the worktree path.
    expect(repoRootOf(wt)).toBe(root)
    expect(repoRootOf(wt)).not.toBe(realpathSync(wt))
  })

  it("returns the main repo root from the main worktree and its subdirs", async () => {
    const root = await makeRepo()
    const sub = join(root, "packages")
    git(root, "worktree", "list") // no-op sanity
    await writeFile(join(root, "f2"), "y")
    // from the repo root
    expect(repoRootOf(root)).toBe(root)
    // from a subdirectory — guards the --path-format=absolute relative trap
    await import("node:fs/promises").then(m => m.mkdir(sub, { recursive: true }))
    expect(repoRootOf(sub)).toBe(root)
  })
})

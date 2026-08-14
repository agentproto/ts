import { describe, it, expect, afterEach } from "vitest"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { realpathSync } from "node:fs"
import { makeOpenPrResolver } from "../commands/worktree.js"

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
  const root = realpathSync(await mkdtemp(join(tmpdir(), "pr-resolver-")))
  cleanupPaths.push(root)
  git(root, "init", "-q", "-b", "main")
  git(root, "config", "user.email", "t@t.t")
  git(root, "config", "user.name", "t")
  git(root, "remote", "add", "origin", "https://github.com/agentproto/ts.git")
  await writeFile(join(root, "f"), "x")
  git(root, "add", ".")
  git(root, "commit", "-q", "-m", "init")
  return root
}

/** A forge that would happily answer for ANY branch — including the default. */
const eagerForge = (calls?: string[]) => async (_repoRoot: string) => ({
  pullRequestsForBranch: async (branch: string) => {
    calls?.push(branch)
    return [
      { number: 797, state: "open" as const, merged: false, mergedAt: null, headRefName: branch, headRefOid: "abc" },
    ]
  },
})

describe("makeOpenPrResolver default-branch guard", () => {
  // The phantom-PR regression: an open PR whose head IS the default branch
  // (real example: #797, head `main`) got attributed to every session sitting
  // at the repo root. On the default branch the resolver must answer null
  // WITHOUT even asking the forge.
  it("returns null on the default branch even when an open PR has that head", async () => {
    const root = await makeRepo()
    const calls: string[] = []
    const resolve = makeOpenPrResolver({ createForge: eagerForge(calls) })
    expect(await resolve(root)).toBeNull()
    expect(calls).toEqual([])
  })

  it("still resolves the open PR for a topic branch", async () => {
    const root = await makeRepo()
    git(root, "checkout", "-q", "-b", "fix/something")
    const resolve = makeOpenPrResolver({ createForge: eagerForge() })
    expect(await resolve(root)).toEqual({
      number: 797,
      url: "https://github.com/agentproto/ts/pull/797",
    })
  })
})

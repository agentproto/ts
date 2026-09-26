import { afterEach, describe, expect, it } from "vitest"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { githubPrUrlBuilder } from "../commands/worktree.js"

const dirs: string[] = []
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

function repoWithOrigin(url?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "pr-url-"))
  dirs.push(dir)
  spawnSync("git", ["init", "-q", dir])
  if (url) spawnSync("git", ["-C", dir, "remote", "add", "origin", url])
  return dir
}

describe("githubPrUrlBuilder", () => {
  it("builds PR web URLs from an ssh or https GitHub origin", () => {
    expect(githubPrUrlBuilder(repoWithOrigin("git@github.com:agentproto/ts.git"))?.(42)).toBe(
      "https://github.com/agentproto/ts/pull/42",
    )
    expect(
      githubPrUrlBuilder(repoWithOrigin("https://github.com/agentik-studio/agentik-studio.git"))?.(7),
    ).toBe("https://github.com/agentik-studio/agentik-studio/pull/7")
    // Multi-account ssh host alias.
    expect(
      githubPrUrlBuilder(repoWithOrigin("git@github.com-agentik:agentik-studio/agentik-studio.git"))?.(307),
    ).toBe("https://github.com/agentik-studio/agentik-studio/pull/307")
  })

  it("builds nothing for a non-GitHub origin or no origin at all", () => {
    expect(githubPrUrlBuilder(repoWithOrigin("git@gitlab.com:o/r.git"))).toBeUndefined()
    expect(githubPrUrlBuilder(repoWithOrigin())).toBeUndefined()
  })
})

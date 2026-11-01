/**
 * `agentproto app install` integrity / build-consent flags: misuse is
 * rejected locally (exit 2) before any daemon round-trip, so these cases
 * never need a running daemon.
 */

import { describe, it, expect, afterEach, vi } from "vitest"

import { runAppInstall } from "../commands/app.js"
import { isWorktreeRepointRefusal } from "../commands/maintain.js"

afterEach(() => {
  vi.restoreAllMocks()
})

async function stderrOf(args: string[]): Promise<{ code: number; err: string }> {
  const writes: string[] = []
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    writes.push(String(chunk))
    return true
  })
  const code = await runAppInstall(args)
  return { code, err: writes.join("") }
}

describe("app install flag validation", () => {
  it("rejects --allow-build on a .agentapp URL", async () => {
    const { code, err } = await stderrOf(["https://example.com/x.agentapp", "--allow-build"])
    expect(code).toBe(2)
    expect(err).toContain("--allow-build only applies to git URLs")
  })

  it("rejects --sha on a .agentapp URL and --sha256 on a git URL", async () => {
    const bundle = await stderrOf(["https://example.com/x.agentapp", "--sha", "abc"])
    expect(bundle.code).toBe(2)
    expect(bundle.err).toContain("--sha256")
    const git = await stderrOf(["https://example.com/repo.git", "--sha256", "abc"])
    expect(git.code).toBe(2)
    expect(git.err).toContain("pin a git URL with --sha")
  })

  it("rejects --repoint on a URL or a .agentapp (local dir only)", async () => {
    const git = await stderrOf(["https://example.com/repo.git", "--repoint"])
    expect(git.code).toBe(2)
    expect(git.err).toContain("--repoint only applies to a local app dir")
    expect((await stderrOf(["./x.agentapp", "--repoint"])).code).toBe(2)
  })

  it("maintain/steward recognise the daemon's worktree re-point refusal, and nothing else", () => {
    expect(isWorktreeRepointRefusal(new Error('app_install: worktree-repoint-refused: "@a/b" is installed from ...'))).toBe(true)
    expect(isWorktreeRepointRefusal(new Error("app_install: unknown daemon tool id(s)"))).toBe(false)
    expect(isWorktreeRepointRefusal("worktree-repoint-refused")).toBe(false)
  })

  it("rejects git-only flags and --sha256 on a local dir", async () => {
    expect((await stderrOf(["./some-dir", "--allow-build"])).code).toBe(2)
    expect((await stderrOf(["./some-dir", "--sha256", "abc"])).code).toBe(2)
  })
})

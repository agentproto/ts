import { describe, it, expect, vi, afterEach } from "vitest"
import { execFileSync } from "node:child_process"
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { InMemoryBranchVerdictStore, recordBranchVerdict } from "@agentproto/worktree"
import { runBranch, runBranchGcApprove, makeBranchGcOperatorApprover, type BranchGcApproveDeps } from "../commands/branch.js"

const SHA = "d".repeat(40)
const daemon = (token = "boot-tok") => async () => ({ found: { url: "http://127.0.0.1:1", ...(token ? { token } : {}) }, stale: [] })

function capture() {
  const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
  const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
  return {
    out: () => out.mock.calls.map(c => String(c[0])).join(""),
    err: () => err.mock.calls.map(c => String(c[0])).join(""),
  }
}

afterEach(() => vi.restoreAllMocks())

describe("agentproto branch gc approve", () => {
  it("needs a target and --by, and is listed in the usage", async () => {
    const io = capture()
    const post = vi.fn()
    expect(await runBranchGcApprove(["--by", "Jeremy"], { discover: daemon(), post })).toBe(2)
    expect(await runBranchGcApprove([SHA], { discover: daemon(), post })).toBe(2)
    expect(await runBranchGcApprove([SHA, "--by", "  "], { discover: daemon(), post })).toBe(2)
    expect(post).not.toHaveBeenCalled()
    expect(await runBranch(["--help"])).toBe(0)
    expect(io.out()).toContain("gc approve")
  })

  it("refuses without a daemon bearer instead of writing the verdict store itself", async () => {
    const io = capture()
    const post = vi.fn()
    expect(await runBranchGcApprove([SHA, "--by", "Jeremy"], { discover: async () => ({ found: null, stale: [] }), post })).toBe(1)
    expect(await runBranchGcApprove([SHA, "--by", "Jeremy"], { discover: daemon(""), post })).toBe(1)
    expect(post).not.toHaveBeenCalled()
    expect(io.err()).toContain("cannot prove operator")
  })

  it("posts each target to the operator route with the bearer, forwarding the session id when run inside a session", async () => {
    const io = capture()
    const calls: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }> = []
    const post: BranchGcApproveDeps["post"] = async (url, body, headers) => {
      calls.push({ url, body: body as Record<string, unknown>, headers })
      const b = body as { target: string; by: string }
      if (b.target === "feat/old") return { status: 409, body: { ok: false, refusal: "tip-moved", target: b.target, message: "the verdict is for an old tip" } }
      return {
        status: 200,
        body: { ok: true, status: "recorded", target: b.target, name: "feat/x", sha: SHA, refs: ["refs/heads/feat/x", "refs/remotes/origin/feat/x"], verdict: { operator: { by: b.by } } },
      }
    }
    const code = await runBranchGcApprove([SHA, "feat/old", "--by", "Jeremy", "--note", "superseded", "--repo", process.cwd()], {
      discover: daemon(),
      post,
      env: {},
    })
    expect(code).toBe(1) // one refusal
    expect(calls.map(c => c.url)).toEqual(["http://127.0.0.1:1/branches/gc/approve", "http://127.0.0.1:1/branches/gc/approve"])
    expect(calls[0]!.headers).toEqual({ authorization: "Bearer boot-tok" })
    expect(calls[0]!.body).toMatchObject({ target: SHA, by: "Jeremy", note: "superseded" })
    expect(io.out()).toContain("approved  feat/x (dddddddddd)  refs: local, origin  by Jeremy")
    expect(io.err()).toContain("refused   feat/old: the verdict is for an old tip")

    calls.length = 0
    await runBranchGcApprove([SHA, "--by", "Jeremy", "--dry-run"], { discover: daemon(), post, env: { AGENTPROTO_SESSION_ID: "sess_reviewer" } })
    expect(calls[0]!.headers["x-agentproto-caller-session-id"]).toBe("sess_reviewer")
    expect(calls[0]!.body.dryRun).toBe(true)
  })

  it("stops at an auth/identity refusal from the daemon with its message", async () => {
    const io = capture()
    const post = vi.fn(async () => ({ status: 403, body: { error: "operator_requires_operator_surface", message: "operator approval must be recorded by the operator, not by a session" } }))
    expect(await runBranchGcApprove([SHA, "feat/y", "--by", "Jeremy"], { discover: daemon(), post, env: {} })).toBe(1)
    expect(post).toHaveBeenCalledTimes(1)
    expect(io.err()).toContain("HTTP 403: operator approval must be recorded by the operator")
  })
})

describe("makeBranchGcOperatorApprover", () => {
  it("records through the engine against the repo's verdict store", async () => {
    const repo = await realpath(await mkdtemp(join(tmpdir(), "bgc-approve-")))
    try {
      const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim()
      git("init", "-q", "-b", "main")
      git("config", "user.email", "t@e.com")
      git("config", "user.name", "T")
      await writeFile(join(repo, "a.txt"), "a\n")
      git("add", "a.txt")
      git("commit", "-q", "-m", "init")
      git("checkout", "-q", "-b", "feat/x")
      await writeFile(join(repo, "b.txt"), "b\n")
      git("add", "b.txt")
      git("commit", "-q", "-m", "work")
      const tip = git("rev-parse", "HEAD")
      git("checkout", "-q", "main")
      const store = new InMemoryBranchVerdictStore()
      const { repoLabel } = await import("@agentproto/worktree")
      await recordBranchVerdict({
        repoRoot: repo,
        repoName: repoLabel(repo),
        store,
        verdict: {
          name: "feat/x",
          sha: tip,
          reviewer: "reviewer",
          triage: { verdict: "obsolete", confidence: 0.9, reason: "dead" },
          gate: { agree: true, verdict: "obsolete", reason: "in base", evidence: ["x"] },
        },
      })
      const approve = makeBranchGcOperatorApprover(() => store)
      expect(await approve({ repoRoot: repo, target: "feat/x", by: "reviewer" })).toMatchObject({ ok: false, refusal: "by-is-reviewer" })
      expect(await approve({ repoRoot: repo, target: "feat/x", by: "Jeremy" })).toMatchObject({ ok: true, status: "recorded", sha: tip })
      expect((await store.get(repoLabel(repo), tip))?.operator).toEqual({ by: "Jeremy" })
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })
})

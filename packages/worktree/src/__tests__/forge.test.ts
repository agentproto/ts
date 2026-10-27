import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  RestForgeClient,
  ForgeUnavailableError,
  parseGithubOwnerRepo,
  createForgeClient,
  GhCliForgeClient,
  UnreachableForgeClient,
  withUnavailableNotice,
} from "../forge.js"
import { tmpdir } from "node:os"
import { execArgv } from "../exec.js"
import type { ExecResult } from "../exec.js"

vi.mock("../exec.js", () => ({ execArgv: vi.fn() }))

const execArgvMock = vi.mocked(execArgv)

function ok(stdout = ""): ExecResult {
  return { exitCode: 0, stdout, stderr: "" }
}
function fail(stderr = "", exitCode = 1): ExecResult {
  return { exitCode, stdout: "", stderr }
}

describe("parseGithubOwnerRepo", () => {
  it("parses an ssh remote URL", () => {
    expect(parseGithubOwnerRepo("git@github.com:agentproto/ts.git")).toEqual({ owner: "agentproto", repo: "ts" })
  })
  it("parses an https remote URL with .git suffix", () => {
    expect(parseGithubOwnerRepo("https://github.com/agentproto/ts.git")).toEqual({ owner: "agentproto", repo: "ts" })
  })
  it("parses an https remote URL without .git suffix", () => {
    expect(parseGithubOwnerRepo("https://github.com/agentproto/ts")).toEqual({ owner: "agentproto", repo: "ts" })
  })
  it("parses an ssh remote through a multi-account host alias", () => {
    expect(parseGithubOwnerRepo("git@github.com-agentik:agentik-studio/agentik-studio.git")).toEqual({
      owner: "agentik-studio",
      repo: "agentik-studio",
    })
  })
  it("normalizes every ssh-alias form of github.com-<alias> to the same slug", () => {
    const want = { owner: "agentik-studio", repo: "agentik-studio" }
    for (const url of [
      "git@github.com-agentik:agentik-studio/agentik-studio",
      "git@github.com-agentik:agentik-studio/agentik-studio.git",
      "git@github.com-agentik:agentik-studio/agentik-studio/",
      "git@github.com-agentik:agentik-studio/agentik-studio.git/",
      "ssh://git@github.com-agentik/agentik-studio/agentik-studio",
      "ssh://git@github.com-agentik/agentik-studio/agentik-studio.git",
      "ssh://git@github.com-agentik/agentik-studio/agentik-studio.git/",
      "ssh://git@github.com-agentik:22/agentik-studio/agentik-studio.git",
      "ssh://git@github.com/agentik-studio/agentik-studio.git",
      "https://github.com-agentik/agentik-studio/agentik-studio",
      "https://github.com-agentik/agentik-studio/agentik-studio.git",
      "https://github.com-agentik/agentik-studio/agentik-studio.git/",
      "https://user@github.com/agentik-studio/agentik-studio.git/",
    ]) {
      expect(parseGithubOwnerRepo(url), url).toEqual(want)
    }
  })
  it("returns null for a non-GitHub remote", () => {
    expect(parseGithubOwnerRepo("git@gitlab.com:agentproto/ts.git")).toBeNull()
    // A lookalike host is not an alias of github.com.
    expect(parseGithubOwnerRepo("git@github.company.com:agentproto/ts.git")).toBeNull()
  })
})

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

describe("RestForgeClient (GITHUB_TOKEN REST fallback)", () => {
  it("normalizes a pulls?head= response into ForgePullRequestRef[]", async () => {
    const fetchFn = async (): Promise<Response> =>
      jsonResponse(200, [
        { number: 1, state: "closed", merged_at: "2026-01-01T00:00:00.000Z", head: { ref: "feat/x", sha: "abc" } },
      ])
    const client = new RestForgeClient("agentproto", "ts", "/repo", "tok", fetchFn)
    const result = await client.pullRequestsForBranch("feat/x")
    expect(result).toEqual([
      { number: 1, state: "closed", merged: true, mergedAt: "2026-01-01T00:00:00.000Z", headRefName: "feat/x", headRefOid: "abc" },
    ])
  })

  it("treats a 404 on commits/:sha/pulls as a legitimate empty result, not an error", async () => {
    const fetchFn = async (): Promise<Response> => new Response("not found", { status: 404 })
    const client = new RestForgeClient("agentproto", "ts", "/repo", "tok", fetchFn)
    expect(await client.pullRequestsForCommit("deadbeef")).toEqual([])
  })

  it("treats a 422 on commits/:sha/pulls (an unpushed commit, verified live) as a legitimate empty result", async () => {
    const fetchFn = async (): Promise<Response> =>
      jsonResponse(422, { message: "No commit found for SHA: deadbeef", status: "422" })
    const client = new RestForgeClient("agentproto", "ts", "/repo", "tok", fetchFn)
    expect(await client.pullRequestsForCommit("deadbeef")).toEqual([])
  })

  it("throws ForgeUnavailableError on a non-2xx, non-404 response", async () => {
    const fetchFn = async (): Promise<Response> => new Response("nope", { status: 500 })
    const client = new RestForgeClient("agentproto", "ts", "/repo", "tok", fetchFn)
    await expect(client.pullRequestsForBranch("feat/x")).rejects.toBeInstanceOf(ForgeUnavailableError)
  })

  it("throws ForgeUnavailableError when fetch itself rejects (network down) — never a guess", async () => {
    const fetchFn = async (): Promise<Response> => {
      throw new Error("ENOTFOUND api.github.com")
    }
    const client = new RestForgeClient("agentproto", "ts", "/repo", "tok", fetchFn)
    await expect(client.pullRequestsForBranch("feat/x")).rejects.toBeInstanceOf(ForgeUnavailableError)
  })

  it("throws ForgeUnavailableError when the response shape doesn't match — never silently accepts garbage", async () => {
    const fetchFn = async (): Promise<Response> => jsonResponse(200, { not: "an array" })
    const client = new RestForgeClient("agentproto", "ts", "/repo", "tok", fetchFn)
    await expect(client.pullRequestsForBranch("feat/x")).rejects.toBeInstanceOf(ForgeUnavailableError)
  })
})

describe("createForgeClient — the `gh` usability probe", () => {
  const savedToken = process.env.GITHUB_TOKEN

  beforeEach(() => {
    execArgvMock.mockReset()
    delete process.env.GITHUB_TOKEN
  })
  afterEach(() => {
    if (savedToken === undefined) delete process.env.GITHUB_TOKEN
    else process.env.GITHUB_TOKEN = savedToken
  })

  it("probes with `gh auth token`, not `gh auth status`", async () => {
    execArgvMock.mockResolvedValue(ok("gho_sometoken"))
    await createForgeClient("/repo")
    const probes = execArgvMock.mock.calls.map(([cmd, args]) => `${cmd} ${args.join(" ")}`)
    expect(probes).toContain("gh auth token --hostname github.com")
    expect(probes).not.toContain("gh auth status")
  })

  it("uses gh when a token is retrievable", async () => {
    execArgvMock.mockResolvedValue(ok("gho_sometoken"))
    expect(await createForgeClient("/repo")).toBeInstanceOf(GhCliForgeClient)
  })

  // The regression this file exists for: `gh auth status` exits non-zero when
  // ANY configured account is broken (e.g. a stale keyring entry for a second
  // account) even though the active credential works. Probing with it made
  // every worktree's integration read `unknown(offline)` and `worktree gc`
  // hold everything it should have reclaimed.
  it("still uses gh when a second account is broken but a token is retrievable", async () => {
    execArgvMock.mockImplementation(async (cmd, args) => {
      if (cmd === "gh" && args[0] === "auth" && args[1] === "status") {
        return fail("X Failed to log in to github.com account other (keyring)")
      }
      if (cmd === "gh" && args[0] === "auth" && args[1] === "token") return ok("gho_sometoken")
      return ok()
    })
    expect(await createForgeClient("/repo")).toBeInstanceOf(GhCliForgeClient)
  })

  it("falls back to unreachable when gh has no usable credential and no GITHUB_TOKEN", async () => {
    execArgvMock.mockResolvedValue(fail("not logged in"))
    expect(await createForgeClient("/repo")).toBeInstanceOf(UnreachableForgeClient)
  })

  it("treats an empty token as unusable rather than a valid credential", async () => {
    execArgvMock.mockResolvedValue(ok("   \n"))
    expect(await createForgeClient("/repo")).toBeInstanceOf(UnreachableForgeClient)
  })
})

const ALIAS_ORIGIN = "git@github.com-agentik:agentik-studio/agentik-studio.git"

function aliasRepoExec(record: Array<{ cmd: string; args: readonly string[]; cwd: string; env?: Record<string, string> }>) {
  return async (
    cmd: string,
    args: readonly string[],
    cwd: string,
    opts?: { env?: Record<string, string> },
  ): Promise<ExecResult> => {
    record.push({ cmd, args, cwd, ...(opts?.env ? { env: opts.env } : {}) })
    if (cmd === "git" && args.includes("get-url")) return ok(`${ALIAS_ORIGIN}\n`)
    if (cmd === "gh" && args[0] === "auth") return ok("gho_sometoken")
    if (cmd === "gh" && args[0] === "pr") return ok("[]")
    if (cmd === "gh" && args[0] === "api") return ok("[]")
    return ok()
  }
}

describe("GhCliForgeClient: independent of cwd-based host detection", () => {
  beforeEach(() => execArgvMock.mockReset())

  it("passes an explicit -R owner/repo resolved from origin to every `gh pr list`", async () => {
    const calls: Array<{ cmd: string; args: readonly string[]; cwd: string; env?: Record<string, string> }> = []
    execArgvMock.mockImplementation(aliasRepoExec(calls))
    const client = new GhCliForgeClient("/repo")
    await client.pullRequestsForBranch("feat/x")
    await client.listOpenPullRequests()
    await client.listMergedPullRequests()
    const prLists = calls.filter((c) => c.cmd === "gh" && c.args[0] === "pr")
    expect(prLists).toHaveLength(3)
    for (const c of prLists) {
      const i = c.args.indexOf("-R")
      expect(c.args[i + 1]).toBe("agentik-studio/agentik-studio")
      expect(c.env?.GH_HOST).toBe("github.com")
    }
  })

  it("never leaves {owner}/{repo} placeholders in `gh api` calls", async () => {
    const calls: Array<{ cmd: string; args: readonly string[]; cwd: string; env?: Record<string, string> }> = []
    execArgvMock.mockImplementation(aliasRepoExec(calls))
    await new GhCliForgeClient("/repo").pullRequestsForCommit("deadbeef")
    const api = calls.find((c) => c.cmd === "gh" && c.args[0] === "api")
    expect(api?.args[1]).toBe("repos/agentik-studio/agentik-studio/commits/deadbeef/pulls")
    expect(api?.env?.GH_HOST).toBe("github.com")
  })

  it("resolves the slug once, not per call", async () => {
    const calls: Array<{ cmd: string; args: readonly string[]; cwd: string }> = []
    execArgvMock.mockImplementation(aliasRepoExec(calls))
    const client = new GhCliForgeClient("/repo")
    await client.pullRequestsForBranch("a")
    await client.pullRequestsForBranch("b")
    expect(calls.filter((c) => c.cmd === "git" && c.args.includes("get-url"))).toHaveLength(1)
  })
})

describe("createForgeClient: alias origins", () => {
  const savedToken = process.env.GITHUB_TOKEN
  beforeEach(() => {
    execArgvMock.mockReset()
    delete process.env.GITHUB_TOKEN
  })
  afterEach(() => {
    if (savedToken === undefined) delete process.env.GITHUB_TOKEN
    else process.env.GITHUB_TOKEN = savedToken
  })

  it("resolves the gh token from a neutral cwd for github.com, not from the repo", async () => {
    const calls: Array<{ cmd: string; args: readonly string[]; cwd: string }> = []
    execArgvMock.mockImplementation(aliasRepoExec(calls))
    expect(await createForgeClient("/repo")).toBeInstanceOf(GhCliForgeClient)
    const probe = calls.find((c) => c.cmd === "gh" && c.args[0] === "auth")
    expect(probe?.args).toEqual(["auth", "token", "--hostname", "github.com"])
    expect(probe?.cwd).toBe(tmpdir())
  })

  it("falls back to REST with the normalized slug when gh is unusable and origin is an ssh:// alias", async () => {
    process.env.GITHUB_TOKEN = "tok"
    execArgvMock.mockImplementation(async (cmd, args) => {
      if (cmd === "gh") return fail("no host")
      if (cmd === "git" && args.includes("get-url")) return ok("ssh://git@github.com-agentik/agentik-studio/agentik-studio.git\n")
      return ok()
    })
    expect(await createForgeClient("/repo")).toBeInstanceOf(RestForgeClient)
  })

  it("says why when it falls back to unreachable", async () => {
    execArgvMock.mockResolvedValue(fail("not logged in"))
    const client = await createForgeClient("/repo")
    expect(client).toBeInstanceOf(UnreachableForgeClient)
    expect((client as UnreachableForgeClient).reason).toMatch(/gh/)
  })
})

describe("withUnavailableNotice: no silent empty status", () => {
  it("notifies once with the reason when the forge is unavailable, and rethrows", async () => {
    const notices: string[] = []
    const client = withUnavailableNotice(new UnreachableForgeClient("gh not authenticated"), (m) => notices.push(m))
    await expect(client.pullRequestsForBranch("a")).rejects.toBeInstanceOf(ForgeUnavailableError)
    await expect(client.pullRequestsForCommit("sha")).rejects.toBeInstanceOf(ForgeUnavailableError)
    expect(notices).toEqual(["forge unavailable: gh not authenticated; PR/merge status shown as unknown(offline)"])
  })

  it("stays silent when the forge answers, including a legitimate empty result", async () => {
    const notices: string[] = []
    const inner = new RestForgeClient("o", "r", "/repo", "tok", async () => jsonResponse(200, []))
    const client = withUnavailableNotice(inner, (m) => notices.push(m))
    expect(await client.pullRequestsForBranch("a")).toEqual([])
    expect(notices).toEqual([])
  })
})

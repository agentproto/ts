import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  RestForgeClient,
  ForgeUnavailableError,
  parseGithubOwnerRepo,
  createForgeClient,
  GhCliForgeClient,
  UnreachableForgeClient,
} from "../forge.js"
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
  it("returns null for a non-GitHub remote", () => {
    expect(parseGithubOwnerRepo("git@gitlab.com:agentproto/ts.git")).toBeNull()
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
    expect(probes).toContain("gh auth token")
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

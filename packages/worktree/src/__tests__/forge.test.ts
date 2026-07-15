import { describe, it, expect } from "vitest"
import { RestForgeClient, ForgeUnavailableError, parseGithubOwnerRepo } from "../forge.js"

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

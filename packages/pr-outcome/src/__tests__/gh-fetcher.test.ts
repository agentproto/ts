import { test } from "vitest"
import assert from "node:assert/strict"
import { GhCliFetcher, buildCheckArgs, buildListArgs, buildNumberArgs } from "../gh-fetcher.js"

test("argv arrays only, with --paginate --slurp", () => {
  assert.deepEqual(buildListArgs("o/r").slice(0, 3), ["api", "--paginate", "--slurp"])
  assert.ok(buildListArgs("o/r")[3]!.startsWith("repos/o/r/pulls?state=closed"))
  assert.equal(buildNumberArgs("o/r", 42, "reviews")[3], "repos/o/r/pulls/42/reviews?per_page=100")
  assert.equal(buildNumberArgs("o/r", 42, "issue-comments")[3], "repos/o/r/issues/42/comments?per_page=100")
  assert.equal(buildCheckArgs("o/r", "abc")[3], "repos/o/r/commits/abc/check-runs?per_page=100")
})

// Fixtures follow the real GitHub REST shapes: no `merged` field on pulls list,
// slurped output is an array of pages, check-runs is { check_runs: [...] }.
const fakeRun = (calls: string[][] = []) => async (args: string[]): Promise<string> => {
  calls.push(args)
  const path = args[3] ?? ""
  if (path.includes("/pulls?")) {
    return JSON.stringify([
      [
        { number: 1, state: "closed", merged_at: "2026-01-02T00:00:00Z", created_at: "2026-01-01T00:00:00Z",
          title: "T", body: "B", head: { ref: "bot/x", sha: "headsha1" }, merge_commit_sha: "mergesha1" },
        { number: 2, state: "closed", merged_at: null, created_at: "2026-01-01T00:00:00Z",
          title: "Closed unmerged", body: null, head: { ref: "y", sha: "h2" }, merge_commit_sha: "m2" },
      ],
      [
        { number: 3, state: "closed", merged_at: "2026-01-03T00:00:00Z", created_at: "2026-01-02T00:00:00Z",
          title: "Page two", body: null, head: { ref: "z", sha: "h3" }, merge_commit_sha: null },
      ],
    ])
  }
  if (path.endsWith("/pulls/1/reviews?per_page=100"))
    return JSON.stringify([[{ user: { login: "rev[bot]", type: "Bot" }, state: "APPROVED", submitted_at: "2026-01-01T01:00:00Z" }], [{ user: null, state: "COMMENTED", submitted_at: null }]])
  if (path.includes("/issues/1/comments"))
    return JSON.stringify([[{ user: { login: "me", type: "User" }, created_at: "2026-01-01T03:00:00Z" }]])
  if (path.includes("/pulls/1/comments"))
    return JSON.stringify([[{ user: { login: "bot[bot]", type: "Bot" }, created_at: "2026-01-01T04:00:00Z" }]])
  if (path.includes("/pulls/1/commits"))
    return JSON.stringify([[{ sha: "s1", commit: { committer: { date: "2026-01-01T02:00:00Z" }, message: "m" } }]])
  if (path.includes("/commits/headsha1/check-runs"))
    return JSON.stringify([{ check_runs: [{ name: "ci", conclusion: "success" }] }, { check_runs: [{ name: "lint", conclusion: null }] }])
  throw new Error(`unexpected path ${path}`)
}

test("listMergedPulls: merged_at filter, page flattening, null-safe mapping", async () => {
  const pulls = await new GhCliFetcher(fakeRun()).listMergedPulls("o/r")
  assert.deepEqual(pulls.map((p) => p.number), [1, 3])
  assert.deepEqual(pulls[0]!, {
    number: 1, state: "closed", merged: true, mergedAt: "2026-01-02T00:00:00Z", createdAt: "2026-01-01T00:00:00Z",
    body: "B", title: "T", headRefName: "bot/x", headSha: "headsha1", mergeCommitSha: "mergesha1",
  })
  assert.equal(pulls[1]!.mergeCommitSha, undefined)
  assert.equal(pulls[1]!.body, "")
})

test("reviews, comments (issue + inline), commits, checks", async () => {
  const f = new GhCliFetcher(fakeRun())
  const reviews = await f.listReviews("o/r", 1)
  assert.equal(reviews.length, 2)
  assert.deepEqual(reviews[0], { authorLogin: "rev[bot]", authorType: "Bot", state: "APPROVED", submittedAt: "2026-01-01T01:00:00Z" })
  assert.deepEqual(reviews[1], { authorLogin: "ghost", authorType: "User", state: "COMMENTED", submittedAt: undefined })

  const comments = await f.listComments("o/r", 1)
  assert.deepEqual(comments.map((c) => [c.authorLogin, c.authorType]), [["me", "User"], ["bot[bot]", "Bot"]])

  assert.deepEqual(await f.listCommits("o/r", 1), [{ committedDate: "2026-01-01T02:00:00Z", message: "m" }])

  const pull = (await f.listMergedPulls("o/r"))[0]!
  assert.deepEqual(await f.listChecks("o/r", pull), [{ name: "ci", conclusion: "success" }, { name: "lint", conclusion: "none" }])
  assert.deepEqual(await f.listChecks("o/r", { ...pull, headSha: undefined }), [])
})

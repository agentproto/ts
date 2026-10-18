import { test } from "vitest"
import assert from "node:assert/strict"
import { collect } from "../collect.js"
import type { GhFetcher } from "../gh-fetcher.js"
import { buildFooter } from "@agentproto/runtime/pr-provenance"
import type { GhPull, GhReview, GhComment, GhCommit, GhCheck } from "../types.js"

const footer = buildFooter({
  prov: {
    sessionId: "sess_1",
    adapter: "claude-code",
    tokensIn: 800,
    tokensOut: 120,
    costUsd: 0.0123,
    source: "adapter",
  },
  authMode: "subscription",
  sha: "sha1",
  kind: "PR",
})

const pullA: GhPull = {
  number: 1,
  state: "closed",
  merged: true,
  mergedAt: "2026-01-02T00:00:00Z",
  createdAt: "2026-01-01T00:00:00Z",
  body: `Automated fix.\n\n---\n${footer}`,
  title: "Fix it",
  headRefName: "bot/fix-it",
}
const pullB: GhPull = {
  ...pullA,
  number: 2,
  body: "legacy PR body, no footer",
  title: "Manual work",
}

const reviewsA: GhReview[] = [
  { authorLogin: "review-bot[bot]", authorType: "Bot", state: "APPROVED", submittedAt: "2026-01-01T04:00:00Z" },
]
const commitsA: GhCommit[] = [
  { committedDate: "2026-01-01T03:00:00Z", message: "fix" },
  { committedDate: "2026-01-01T05:00:00Z", message: "fixup" },
]
const checksA: GhCheck[] = [{ name: "ci", conclusion: "success" }]

const fetcher: GhFetcher = {
  listMergedPulls: async () => [pullA, pullB],
  listReviews: async (_, n) => (n === 1 ? reviewsA : []),
  listComments: async () => [] as GhComment[],
  listCommits: async (_, n) => (n === 1 ? commitsA : []),
  listChecks: async () => checksA,
}

test("collect joins provenance and computes outcomes", async () => {
  const { outcomes, skipped } = await collect(fetcher, "agentproto/ts", { now: "2026-01-03T00:00:00Z" })
  assert.equal(skipped.length, 0)
  assert.equal(outcomes.length, 2)

  const a = outcomes[0]!
  assert.equal(a.number, 1)
  assert.equal(a.provenance?.sessionId, "sess_1")
  assert.equal(a.provenance?.adapter, "claude-code")
  assert.equal(a.provenance?.authMode, "subscription")
  assert.equal(a.provenance?.tokensIn, 800)
  assert.equal(a.provenance?.tokensOut, 120)
  assert.equal(a.provenance?.costUsd, 0.0123)
  assert.equal(a.provenance?.sha, "sha1")
  assert.equal(a.reviews.bot, 1)
  assert.equal(a.commitsAfterFirstReview, 1)
  assert.equal(a.ciFailures, 0)
  assert.equal(a.basis, "observed")
  assert.equal(a.timeToMergeMinutes, 24 * 60)

  const b = outcomes[1]!
  assert.equal(b.provenance, undefined)
  assert.equal(b.reviews.bot, 0)
})

test("fetcher failure on one PR records skip and continues", async () => {
  const failing: GhFetcher = {
    ...fetcher,
    listReviews: async (_, n) => {
      if (n === 2) throw new Error("gh: rate limited")
      return reviewsA
    },
  }
  const { outcomes, skipped } = await collect(failing, "agentproto/ts", { now: "2026-01-03T00:00:00Z" })
  assert.equal(outcomes.length, 1)
  assert.equal(outcomes[0]!.number, 1)
  assert.equal(skipped.length, 1)
  assert.equal(skipped[0]!.number, 2)
  assert.ok(skipped[0]!.reason.includes("rate limited"))
})

test("listMergedPulls failure skips everything", async () => {
  const { outcomes, skipped } = await collect(
    {
      ...fetcher,
      listMergedPulls: async () => {
        throw new Error("boom")
      },
    },
    "agentproto/ts",
  )
  assert.equal(outcomes.length, 0)
  assert.equal(skipped.length, 1)
  assert.ok(skipped[0]!.reason.includes("boom"))
})

test("limit option restricts pulls", async () => {
  const { outcomes } = await collect(fetcher, "agentproto/ts", { limit: 1, now: "2026-01-03T00:00:00Z" })
  assert.equal(outcomes.length, 1)
  assert.equal(outcomes[0]!.number, 1)
})

test("revert detection uses only PRs merged after the inspected one", async () => {
  const bad: GhPull = { ...pullA, number: 5, title: "Bad change", body: "", mergedAt: "2026-01-02T00:00:00Z", mergeCommitSha: "aaaa1111bbbb2222" }
  const later: GhPull = { ...pullA, number: 6, title: 'Revert "Bad change"', body: "", mergedAt: "2026-01-04T00:00:00Z" }
  const bySha: GhPull = { ...pullA, number: 8, title: "Rollback", body: "This reverts commit aaaa1111bbbb2222.", mergedAt: "2026-01-05T00:00:00Z" }
  const f: GhFetcher = { ...fetcher, listMergedPulls: async () => [later, bySha, bad] }
  const { outcomes } = await collect(f, "agentproto/ts", { now: "2026-01-06T00:00:00Z" })
  const byNum = Object.fromEntries(outcomes.map((o) => [o.number, o.reverted]))
  assert.equal(byNum[5], true)
  assert.equal(byNum[6], false)
  assert.equal(byNum[8], false)

  const earlierRevert: GhPull = { ...later, mergedAt: "2026-01-01T00:00:00Z" }
  const r = await collect({ ...fetcher, listMergedPulls: async () => [earlierRevert, bad] }, "agentproto/ts", { now: "2026-01-06T00:00:00Z" })
  assert.equal(r.outcomes.find((o) => o.number === 5)?.reverted, false)
})

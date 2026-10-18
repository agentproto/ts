import { test } from "vitest"
import assert from "node:assert/strict"
import { computeOutcome, countCiFailures, isBotAuthor } from "../outcome.js"
import type { GhPull, GhReview, GhComment, GhCommit, GhCheck } from "../types.js"

const pull: GhPull = {
  number: 42,
  state: "closed",
  merged: true,
  mergedAt: "2026-01-02T00:00:00Z",
  createdAt: "2026-01-01T00:00:00Z",
  body: "fixes a bug",
  title: "Fix foo",
  headRefName: "fix-foo",
}

const reviews: GhReview[] = [
  { authorLogin: "someone-bot", authorType: "Bot", state: "APPROVED", submittedAt: "2026-01-01T06:00:00Z" },
  { authorLogin: "alice", authorType: "User", state: "CHANGES_REQUESTED", submittedAt: "2026-01-01T07:00:00Z" },
  { authorLogin: "ci[bot]", authorType: "User", state: "COMMENTED", submittedAt: "2026-01-01T08:00:00Z" },
]

const comments: GhComment[] = [
  { authorLogin: "someone-bot", authorType: "Bot", createdAt: "2026-01-01T07:10:00Z" },
  { authorLogin: "bob", authorType: "User", createdAt: "2026-01-01T07:20:00Z" },
]

const commits: GhCommit[] = [
  { committedDate: "2026-01-01T05:00:00Z", message: "fix foo" },
  { committedDate: "2026-01-01T08:30:00Z", message: "address review" },
  { committedDate: "2026-01-01T09:30:00Z", message: "lint" },
]

const checks: GhCheck[] = [
  { name: "ci", conclusion: "success" },
  { name: "lint", conclusion: "failure" },
  { name: "e2e", conclusion: "timed_out" },
  { name: "deploy", conclusion: "cancelled" },
]

test("bot detection: authorType Bot or [bot]-suffixed login", () => {
  assert.equal(isBotAuthor("Bot", "someone-bot"), true)
  assert.equal(isBotAuthor("User", "ci[bot]"), true)
  assert.equal(isBotAuthor("User", "alice"), false)
})

test("bot-reviewed PR with fix commits", () => {
  const o = computeOutcome(
    { repo: "agentproto/ts", pull, reviews, comments, commits, checks },
    "2026-01-03T00:00:00Z",
  )
  assert.equal(o.reviews.bot, 2) // someone-bot (type Bot) + ci[bot] (login suffix)
  assert.equal(o.reviews.human, 1) // alice
  assert.equal(o.comments.bot, 1)
  assert.equal(o.comments.human, 1)
  assert.equal(o.changesRequested, true)
  assert.equal(o.commitsAfterFirstReview, 2) // commits after 06:00 first review
  assert.equal(countCiFailures(checks), 3)
  assert.equal(o.reverted, false)
  assert.equal(o.state, "closed")
  assert.equal(o.mergedAt, "2026-01-02T00:00:00Z")
  assert.equal(o.timeToMergeMinutes, 24 * 60)
  assert.equal(o.basis, "observed")
  assert.equal(o.collectedAt, "2026-01-03T00:00:00Z")
})

test("clean PR without reviews/checks: unobservable fields stay at zero, time undefined if not merged", () => {
  const open: GhPull = { ...pull, state: "open", merged: false, mergedAt: undefined }
  const o = computeOutcome(
    { repo: "agentproto/ts", pull: open, reviews: [], comments: [], commits: [], checks: [] },
  )
  assert.equal(o.reviews.human, 0)
  assert.equal(o.reviews.bot, 0)
  assert.equal(o.changesRequested, false)
  assert.equal(o.commitsAfterFirstReview, 0)
  assert.equal(o.ciFailures, 0)
  assert.equal(o.timeToMergeMinutes, undefined)
  assert.equal(o.mergedAt, undefined)
})

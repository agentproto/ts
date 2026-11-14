import { test } from "node:test"
import assert from "node:assert/strict"
import {
  decideReviewReconciliation,
  isBotReview,
  normalizeConclusion,
  pickConclusion,
} from "./reconcile-review-state.mjs"

const SHA = "abc123"
const bot = (state, extra = {}) => ({
  id: extra.id ?? `${state}-${extra.submitted_at ?? ""}`,
  state,
  commit_id: extra.commit_id ?? SHA,
  submitted_at: extra.submitted_at ?? "2026-01-01T00:00:00Z",
  user: { type: extra.userType ?? "Bot", login: "agentproto-bot" },
})

// This test fails on the pre-fix code: there was no reconciliation at all, so
// the reviewer's "## Verdict: Approve" stayed a COMMENTED review and the PR
// stayed REVIEW_REQUIRED (PR #2616).
test("an approve posted as COMMENTED is upgraded to an APPROVE review", () => {
  const decision = decideReviewReconciliation({
    verdict: "approved",
    headSha: SHA,
    reviews: [bot("COMMENTED")],
  })
  assert.equal(decision.action, "submit")
  assert.equal(decision.event, "APPROVE")
  assert.match(decision.body, /stated approve verdict/)
  assert.match(decision.body, /COMMENTED/)
  assert.equal(decision.body.includes("\n"), false, "body must be one line")
  assert.doesNotMatch(decision.body, /generated|co-authored|assistant/i)
})

test("a request_changes posted as COMMENTED is upgraded symmetrically", () => {
  const decision = decideReviewReconciliation({
    verdict: "request_changes",
    headSha: SHA,
    reviews: [bot("COMMENTED")],
  })
  assert.equal(decision.action, "submit")
  assert.equal(decision.event, "REQUEST_CHANGES")
  assert.match(decision.body, /stated request-changes verdict/)
})

test("idempotent: an existing APPROVED bot review on the sha is left alone", () => {
  const decision = decideReviewReconciliation({
    verdict: "approve",
    headSha: SHA,
    reviews: [bot("APPROVED", { id: 1 }), bot("COMMENTED", { id: 2, submitted_at: "2026-01-02T00:00:00Z" })],
  })
  assert.equal(decision.action, "none")
  assert.match(decision.reason, /already exists/)
})

test("idempotent: an existing REQUEST_CHANGES bot review on the sha is left alone", () => {
  const decision = decideReviewReconciliation({
    verdict: "request_changes",
    headSha: SHA,
    reviews: [bot("CHANGES_REQUESTED")],
  })
  assert.equal(decision.action, "none")
})

test("only a COMMENTED latest bot review on the target sha triggers a post", () => {
  const olderComment = bot("COMMENTED", { id: 1, submitted_at: "2026-01-01T00:00:00Z" })
  const newerApprove = bot("APPROVED", { id: 2, submitted_at: "2026-01-02T00:00:00Z" })
  const d1 = decideReviewReconciliation({ verdict: "approve", headSha: SHA, reviews: [olderComment, newerApprove] })
  assert.equal(d1.action, "none")

  const otherSha = bot("COMMENTED", { commit_id: "other" })
  const d2 = decideReviewReconciliation({ verdict: "approve", headSha: SHA, reviews: [otherSha] })
  assert.equal(d2.action, "none")
  assert.match(d2.reason, /no bot review/)

  const human = bot("COMMENTED", { userType: "User" })
  const d3 = decideReviewReconciliation({ verdict: "approve", headSha: SHA, reviews: [human] })
  assert.equal(d3.action, "none")
})

test("no decisive verdict or no sha is a no-op", () => {
  assert.equal(decideReviewReconciliation({ verdict: "", headSha: SHA, reviews: [bot("COMMENTED")] }).action, "none")
  assert.equal(
    decideReviewReconciliation({ verdict: "incomplete", headSha: SHA, reviews: [bot("COMMENTED")] }).action,
    "none",
  )
  assert.equal(decideReviewReconciliation({ verdict: "approve", headSha: "", reviews: [bot("COMMENTED")] }).action, "none")
})

test("normalizeConclusion reads both structured-verdict spellings", () => {
  assert.equal(normalizeConclusion("approve"), "approve")
  assert.equal(normalizeConclusion("approved"), "approve")
  assert.equal(normalizeConclusion("request_changes"), "request_changes")
  assert.equal(normalizeConclusion("changes_requested"), "request_changes")
  assert.equal(normalizeConclusion("Changes Requested"), "request_changes")
  assert.equal(normalizeConclusion("incomplete"), undefined)
})

test("pickConclusion skips non-decisive tiers so a failed primary cannot mask a fallback", () => {
  assert.equal(pickConclusion(["incomplete", "approved"]), "approve")
  assert.equal(pickConclusion(["failed", "changes_requested"]), "request_changes")
  assert.equal(pickConclusion(["", undefined, "approved"]), "approve")
  assert.equal(pickConclusion(["", "incomplete", "failed"]), undefined)
})

test("isBotReview only trusts user.type Bot", () => {
  assert.equal(isBotReview(bot("COMMENTED")), true)
  assert.equal(isBotReview(bot("COMMENTED", { userType: "User" })), false)
  assert.equal(isBotReview(null), false)
})

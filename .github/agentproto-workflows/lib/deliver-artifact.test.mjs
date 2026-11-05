import { test } from "node:test"
import assert from "node:assert/strict"
import { parseArgs, reconcileReviewEvent, verdictOfReviewBody } from "./deliver-artifact.mjs"

test("parseArgs reads the flags the delivery recipes pass", () => {
  const opts = parseArgs([
    "--kind",
    "pr",
    "--url",
    "https://api.github.com/repos/o/r/pulls",
    "--body-file",
    "pr.json",
  ])
  assert.equal(opts.kind, "pr")
  assert.equal(opts.url, "https://api.github.com/repos/o/r/pulls")
  assert.equal(opts.bodyFile, "pr.json")
  assert.equal(opts.method, "POST") // default
})

test("parseArgs uppercases --method and reads --sha/--ledger", () => {
  const opts = parseArgs([
    "--kind",
    "review",
    "--method",
    "put",
    "--sha",
    "abc123",
    "--ledger",
    "/tmp/led.ndjson",
  ])
  assert.equal(opts.method, "PUT")
  assert.equal(opts.sha, "abc123")
  assert.equal(opts.ledger, "/tmp/led.ndjson")
})

test("parseArgs ignores unknown flags rather than aborting", () => {
  const opts = parseArgs(["--kind", "comment", "--surprise", "x", "--url", "u", "--body-file", "b"])
  assert.equal(opts.kind, "comment")
  assert.equal(opts.url, "u")
  assert.equal(opts.bodyFile, "b")
})

const review = (event, verdictLine) =>
  JSON.stringify({ event, body: `## Summary\n\nStuff.\n\n## Verdict\n\n${verdictLine}\n\n---\n<sub>footer</sub>` })

test("verdictOfReviewBody reads the Verdict section, bold or plain", () => {
  assert.equal(verdictOfReviewBody("## Verdict\n\n**Approve.** All good."), "approve")
  assert.equal(verdictOfReviewBody("## Verdict\n\nApprove with nits"), "approve")
  assert.equal(verdictOfReviewBody("## Verdict\n\n**Request changes**: 11 tests pin the old ladder"), "request_changes")
  assert.equal(verdictOfReviewBody("## Verdict\n\nLooks fine but see above"), undefined)
  assert.equal(verdictOfReviewBody("no verdict section at all"), undefined)
  assert.equal(verdictOfReviewBody("## Findings\n\nApprove everything\n"), undefined)
})

test("a COMMENT whose verdict says Approve is posted as APPROVE (the #2548 case)", () => {
  const r = reconcileReviewEvent(review("COMMENT", "**Approve.** The shard math checks out."))
  assert.equal(r.changed, "APPROVE")
  assert.equal(JSON.parse(r.payload).event, "APPROVE")
  assert.ok(JSON.parse(r.payload).body.includes("## Verdict"))
})

test("a COMMENT whose verdict says Request changes is posted as REQUEST_CHANGES", () => {
  const r = reconcileReviewEvent(review("COMMENT", "**Request changes**: tests pin the old ladder."))
  assert.equal(r.changed, "REQUEST_CHANGES")
  assert.equal(JSON.parse(r.payload).event, "REQUEST_CHANGES")
})

test("only COMMENT is ever changed: a deliberate APPROVE / REQUEST_CHANGES is left alone", () => {
  assert.equal(reconcileReviewEvent(review("APPROVE", "**Request changes**: x")).changed, null)
  assert.equal(reconcileReviewEvent(review("REQUEST_CHANGES", "**Approve.**")).changed, null)
})

test("an unclear verdict or a non-JSON payload is posted unchanged", () => {
  const unclear = review("COMMENT", "See the findings above.")
  assert.deepEqual(reconcileReviewEvent(unclear), { payload: unclear, changed: null })
  assert.deepEqual(reconcileReviewEvent("not json"), { payload: "not json", changed: null })
})

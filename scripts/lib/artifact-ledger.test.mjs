import { test } from "node:test"
import assert from "node:assert/strict"
import {
  ARTIFACT_MARKER,
  buildArtifactRecord,
  formatArtifactMarker,
  parseArtifactMarkers,
  parseArtifacts,
  pickArtifact,
  serializeLedgerLine,
} from "./artifact-ledger.mjs"

// ── buildArtifactRecord ──────────────────────────────────────────────────────

test("buildArtifactRecord maps a PR create response (id, number, url, head.sha)", () => {
  const rec = buildArtifactRecord({
    kind: "pr",
    response: { id: 42, number: 7, html_url: "https://x/pull/7", head: { sha: "deadbeef" } },
  })
  assert.deepEqual(rec, { kind: "pr", id: 42, number: 7, url: "https://x/pull/7", sha: "deadbeef" })
})

test("buildArtifactRecord maps a review response (commit_id → sha, no number)", () => {
  const rec = buildArtifactRecord({
    kind: "review",
    response: { id: 99, html_url: "https://x/pull/7#r99", commit_id: "abc123" },
  })
  assert.deepEqual(rec, { kind: "review", id: 99, url: "https://x/pull/7#r99", sha: "abc123" })
})

test("buildArtifactRecord falls back to the passed sha when the response has none", () => {
  const rec = buildArtifactRecord({ kind: "comment", response: { id: 5 }, sha: "fallback" })
  assert.deepEqual(rec, { kind: "comment", id: 5, sha: "fallback" })
})

test("buildArtifactRecord returns null for an unknown kind or a response with no id", () => {
  assert.equal(buildArtifactRecord({ kind: "nope", response: { id: 1 } }), null)
  assert.equal(buildArtifactRecord({ kind: "pr", response: { number: 7 } }), null)
  assert.equal(buildArtifactRecord({ kind: "pr", response: null }), null)
})

test("buildArtifactRecord attaches sessionId when provided", () => {
  const rec = buildArtifactRecord({ kind: "pr", response: { id: 1, number: 2 }, sessionId: "sess_x" })
  assert.equal(rec.sessionId, "sess_x")
})

// ── marker round-trip ────────────────────────────────────────────────────────

test("formatArtifactMarker prefixes with the sentinel and is JSON-parseable", () => {
  const rec = { kind: "pr", id: 1, number: 2 }
  const line = formatArtifactMarker(rec)
  assert.ok(line.startsWith(ARTIFACT_MARKER))
  assert.deepEqual(JSON.parse(line.slice(ARTIFACT_MARKER.length)), rec)
})

test("serializeLedgerLine is one newline-terminated JSON record", () => {
  assert.equal(serializeLedgerLine({ kind: "pr", id: 1 }), '{"kind":"pr","id":1}\n')
})

// ── parseArtifactMarkers (driver harvest) ────────────────────────────────────

test("parseArtifactMarkers pulls records out of surrounding log noise", () => {
  const text = [
    "some tool output",
    formatArtifactMarker({ kind: "pr", id: 10, number: 3 }),
    "more output",
    "deliver-artifact: created pr id=10",
    formatArtifactMarker({ kind: "review", id: 20 }),
  ].join("\n")
  const recs = parseArtifactMarkers(text)
  assert.deepEqual(recs, [
    { kind: "pr", id: 10, number: 3 },
    { kind: "review", id: 20 },
  ])
})

test("parseArtifactMarkers merges extra (sessionId) only when absent", () => {
  const text = [
    formatArtifactMarker({ kind: "pr", id: 1 }),
    formatArtifactMarker({ kind: "review", id: 2, sessionId: "already" }),
  ].join("\n")
  const recs = parseArtifactMarkers(text, { sessionId: "sess_from_driver" })
  assert.equal(recs[0].sessionId, "sess_from_driver")
  assert.equal(recs[1].sessionId, "already")
})

test("parseArtifactMarkers tolerates a marker with trailing text on the line", () => {
  const text = `${ARTIFACT_MARKER}{"kind":"pr","id":7}   `
  assert.deepEqual(parseArtifactMarkers(text), [{ kind: "pr", id: 7 }])
})

test("parseArtifactMarkers skips malformed / non-artifact markers, never throws", () => {
  const text = [
    `${ARTIFACT_MARKER}{not json`,
    `${ARTIFACT_MARKER}{"kind":"pr"}`, // no id
    `${ARTIFACT_MARKER}{"kind":"bogus","id":1}`, // bad kind
    formatArtifactMarker({ kind: "pr", id: 9 }),
  ].join("\n")
  assert.deepEqual(parseArtifactMarkers(text), [{ kind: "pr", id: 9 }])
})

test("parseArtifactMarkers returns [] for text without a marker", () => {
  assert.deepEqual(parseArtifactMarkers("nothing here"), [])
  assert.deepEqual(parseArtifactMarkers(undefined), [])
})

// ── parseArtifacts + pickArtifact (stamp scripts) ────────────────────────────

test("parseArtifacts parses the ARTIFACTS env array and drops bad entries", () => {
  const raw = JSON.stringify([
    { kind: "pr", id: 1, number: 2 },
    { kind: "bogus", id: 9 },
    "junk",
    { kind: "review", id: 3 },
  ])
  assert.deepEqual(parseArtifacts(raw), [
    { kind: "pr", id: 1, number: 2 },
    { kind: "review", id: 3 },
  ])
})

test("parseArtifacts returns [] for empty / unset / unparseable input", () => {
  assert.deepEqual(parseArtifacts(""), [])
  assert.deepEqual(parseArtifacts(undefined), [])
  assert.deepEqual(parseArtifacts("not json"), [])
  assert.deepEqual(parseArtifacts("{}"), [])
})

test("pickArtifact selects the NEWEST record of a kind (append order = latest wins)", () => {
  const artifacts = [
    { kind: "review", id: 1 },
    { kind: "pr", id: 2, number: 5 },
    { kind: "review", id: 3 }, // newer review
  ]
  assert.deepEqual(pickArtifact(artifacts, "review"), { kind: "review", id: 3 })
  assert.deepEqual(pickArtifact(artifacts, "pr"), { kind: "pr", id: 2, number: 5 })
})

test("pickArtifact returns null when nothing of the kind is present", () => {
  assert.equal(pickArtifact([{ kind: "pr", id: 1 }], "review"), null)
  assert.equal(pickArtifact([], "pr"), null)
  assert.equal(pickArtifact(null, "pr"), null)
})

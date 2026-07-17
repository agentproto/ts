/**
 * Regression tests for the @agentproto/cli@0.5.0 incident: the generator's own
 * console trace was published as that release's body (432 lines of "⟳ Turn 1 /
 * 🔧 read_changelog(name)"), and the model invented the release date, tagging a
 * July-2026 batch as `release/2025-07`. Also covers the later month-granularity
 * bug: titling every batch "agentproto — July 2026 release" produced multiple
 * identically-titled releases once this repo started shipping several batches
 * a month.
 *
 * Run: node --test scripts/release-notes.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  assertPublishable,
  CONSOLIDATED_TAG,
  RELEASE_DATE_LONG,
  THIS_YEAR,
  TODAY,
  appendBatchMarker,
  batchMarker,
  bodyBatchSha,
  selectReleaseTarget,
  suffixTitle,
} from './release-notes.mjs'

// Verbatim shape of what actually got published to @agentproto/cli@0.5.0.
const REAL_TRACE_BODY = `
📦 Release notes generator starting (dry-run)…

⟳  Turn 1
   🔧 list_published_packages()
   🔧 list_git_tags()

⟳  Turn 2
   🔧 read_changelog(name)
   🔧 read_changelog(name)

⟳  Turn 10
   🔧 post_consolidated_release(title, tag, body)

[DRY-RUN] Would create consolidated release "agentproto — July 2025 release" (release/2025-07):
---
# agentproto — July 2025 release

> This release ships a complete auth/credential brokering stack, isolated sandbox
> execution via E2B, and a production-grade eval harness with LLM-judge scoring.

## What's new

### Add pluggable credential brokering and device-code auth

The new package implements AIP-50 end to end, shipping three CredentialStore
backends and a full RFC 8628 device-code flow engine with daemon-side credential
persistence, proactive refresh, and audience scoping across every provider path.
---

✅ Release notes complete.
`

const GOOD_BODY = `# agentproto — ${RELEASE_DATE_LONG} release

> This release ships credential brokering, sandboxed execution, and honest cost
> accounting across 37 packages.

## What's new

### Add pluggable credential brokering and device-code auth (\`@agentproto/auth@0.1.0\`)

The new package implements AIP-50 end to end, shipping three CredentialStore
backends and a full RFC 8628 device-code flow engine with daemon-side credential
persistence, proactive refresh, and audience scoping across every provider path.
`

test('rejects the exact body that shipped to @agentproto/cli@0.5.0', () => {
  // The whole point. If this ever passes, the incident can recur.
  assert.throws(() => assertPublishable(REAL_TRACE_BODY, 'test'), /generator trace output/)
})

test('rejects each trace marker on its own', () => {
  // A partial trace is still a trace — don't rely on the full banner being present.
  const cases = [
    '# Real looking heading\n\n' + 'x'.repeat(300) + '\n⟳  Turn 3\n',
    '# Real looking heading\n\n' + 'x'.repeat(300) + '\n   🔧 read_changelog(name)\n',
    '# Real looking heading\n\n' + 'x'.repeat(300) + '\n[DRY-RUN] Would create consolidated release "x" (y):\n',
    '# Real looking heading\n\n' + 'x'.repeat(300) + '\n✅ Release notes complete.\n',
    '# Real looking heading\n\n' + 'x'.repeat(300) + '\n📦 Release notes generator starting…\n',
  ]
  for (const body of cases) {
    assert.throws(() => assertPublishable(body, 'test'), /generator trace output/, `should reject: ${body.slice(-40)}`)
  }
})

test('rejects a body with no markdown heading', () => {
  assert.throws(() => assertPublishable('just some prose '.repeat(30), 'test'), /no markdown heading/)
})

test('rejects an empty or stub body', () => {
  assert.throws(() => assertPublishable('', 'test'), /empty or implausibly short/)
  assert.throws(() => assertPublishable('# hi', 'test'), /empty or implausibly short/)
  assert.throws(() => assertPublishable(undefined, 'test'), /empty or implausibly short/)
})

test('accepts a genuine release note', () => {
  assert.doesNotThrow(() => assertPublishable(GOOD_BODY, 'test'))
})

test('the consolidated tag is computed from the clock, not the model', () => {
  // `release/2025-07` came from the model. The tag must now be today's date, and
  // must always carry the real current year.
  assert.match(CONSOLIDATED_TAG, /^release\/\d{4}-\d{2}-\d{2}$/)
  assert.equal(CONSOLIDATED_TAG, `release/${TODAY}`)
  assert.ok(CONSOLIDATED_TAG.includes(THIS_YEAR), 'tag must carry the current year')
})

test('RELEASE_DATE_LONG carries the real current year, at day granularity', () => {
  assert.match(RELEASE_DATE_LONG, new RegExp(`^[A-Z][a-z]+ \\d{1,2}, ${THIS_YEAR}$`))
})

// ── same-day second batch (the release/2026-07-17 overwrite) ──────────────────
//
// The per-day tag meant a second release batch published the same day hit the
// "tag exists" catch branch written for an idempotent re-run — and replaced the
// first batch's title and body wholesale. Not a merge: list_published_packages
// only ever sees the LATEST version-bump commit, so the regenerated body covered
// batch 2 alone and batch 1's notes were simply gone.

const SHA_A = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
const SHA_B = 'b2c3d4e5f60718293a4b5c6d7e8f90123456789a'

/** fetchBody stub: a tag→body map; anything absent has no release. */
const fetcher = (releases) => (tag) => (tag in releases ? releases[tag] : null)

const bodyFor = (sha) => appendBatchMarker(`# agentproto — some release\n\n${'x'.repeat(250)}`, sha)

test('a re-run of the same batch edits in place at the base tag', () => {
  // The force_post_release_steps backfill / a reconcile-driven re-run. This is
  // the behaviour the old catch branch got right, and it must survive.
  const target = selectReleaseTarget({
    baseTag: CONSOLIDATED_TAG,
    batchSha: SHA_A,
    fetchBody: fetcher({ [CONSOLIDATED_TAG]: bodyFor(SHA_A) }),
  })
  assert.deepEqual(target, { tag: CONSOLIDATED_TAG, attempt: 1, mode: 'edit' })
})

test('a different batch on the same day mints .2 instead of overwriting', () => {
  // The actual bug. Batch A is live at the base tag; batch B must not touch it.
  const target = selectReleaseTarget({
    baseTag: CONSOLIDATED_TAG,
    batchSha: SHA_B,
    fetchBody: fetcher({ [CONSOLIDATED_TAG]: bodyFor(SHA_A) }),
  })
  assert.deepEqual(target, { tag: `${CONSOLIDATED_TAG}.2`, attempt: 2, mode: 'create' })
})

test('a legacy release with no marker falls safe to .2 rather than being overwritten', () => {
  // Every consolidated release published before this fix — including the live
  // release/2026-07-17 carrying the 0.7.0 notes — has no marker. Unidentifiable
  // means "not mine": mint a new tag. A spurious .2 is recoverable; a wiped
  // release is not. Self-heals within a day.
  const target = selectReleaseTarget({
    baseTag: CONSOLIDATED_TAG,
    batchSha: SHA_A,
    fetchBody: fetcher({ [CONSOLIDATED_TAG]: '# agentproto — July 17, 2026 release\n\nNo marker here.' }),
  })
  assert.deepEqual(target, { tag: `${CONSOLIDATED_TAG}.2`, attempt: 2, mode: 'create' })
})

test('the free base tag is used as-is, with no suffix', () => {
  const target = selectReleaseTarget({ baseTag: CONSOLIDATED_TAG, batchSha: SHA_A, fetchBody: fetcher({}) })
  assert.deepEqual(target, { tag: CONSOLIDATED_TAG, attempt: 1, mode: 'create' })
})

test('the walk keeps stepping past occupied suffixed tags', () => {
  const target = selectReleaseTarget({
    baseTag: CONSOLIDATED_TAG,
    batchSha: SHA_B,
    fetchBody: fetcher({
      [CONSOLIDATED_TAG]: bodyFor(SHA_A),
      [`${CONSOLIDATED_TAG}.2`]: 'legacy, no marker',
      [`${CONSOLIDATED_TAG}.3`]: bodyFor(SHA_A),
    }),
  })
  assert.deepEqual(target, { tag: `${CONSOLIDATED_TAG}.4`, attempt: 4, mode: 'create' })
})

test('a re-run finds its own batch at a suffixed tag and edits there', () => {
  // Batch B was pushed to .2 yesterday's-run-style; re-running it must land back
  // on .2, not mint .3 and not touch batch A at the base tag.
  const target = selectReleaseTarget({
    baseTag: CONSOLIDATED_TAG,
    batchSha: SHA_B,
    fetchBody: fetcher({ [CONSOLIDATED_TAG]: bodyFor(SHA_A), [`${CONSOLIDATED_TAG}.2`]: bodyFor(SHA_B) }),
  })
  assert.deepEqual(target, { tag: `${CONSOLIDATED_TAG}.2`, attempt: 2, mode: 'edit' })
})

test('an unidentifiable run (no batch sha) never claims an existing release', () => {
  // Can't prove which batch it is ⇒ must not edit blind.
  const target = selectReleaseTarget({
    baseTag: CONSOLIDATED_TAG,
    batchSha: null,
    fetchBody: fetcher({ [CONSOLIDATED_TAG]: bodyFor(SHA_A) }),
  })
  assert.equal(target.mode, 'create')
  assert.equal(target.tag, `${CONSOLIDATED_TAG}.2`)
})

test('the walk is capped rather than spinning forever', () => {
  // Every tag occupied by someone else's batch: fail loudly.
  assert.throws(
    () => selectReleaseTarget({ baseTag: CONSOLIDATED_TAG, batchSha: SHA_B, fetchBody: () => bodyFor(SHA_A) }),
    /all held by other batches/,
  )
})

test('the title gets a (2) suffix only when the tag is suffixed', () => {
  const title = `agentproto — ${RELEASE_DATE_LONG} release`
  assert.equal(suffixTitle(title, 1), title)
  assert.equal(suffixTitle(title, 2), `${title} (2)`)
  assert.equal(suffixTitle(title, 3), `${title} (3)`)
})

test('the model does not get to number the title itself', () => {
  // Same rule as the tag and the year: a suffix the model invented is stripped
  // and re-derived from the computed attempt.
  const title = `agentproto — ${RELEASE_DATE_LONG} release`
  assert.equal(suffixTitle(`${title} (7)`, 1), title)
  assert.equal(suffixTitle(`${title} (7)`, 2), `${title} (2)`)
})

test('the batch marker round-trips and stays invisible in the rendered body', () => {
  const body = `# agentproto — a release\n\n${'x'.repeat(250)}`
  const marked = appendBatchMarker(body, SHA_A)
  assert.equal(bodyBatchSha(marked), SHA_A)
  assert.ok(marked.includes(batchMarker(SHA_A)))
  assert.match(marked, /^<!-- agentproto-batch: [0-9a-f]{40} -->$/m)
  // HTML comment: renders as nothing on GitHub, so the prose is unaffected.
  assert.ok(marked.startsWith(body))
})

test('a marked body still passes the publish gate', () => {
  // The marker is appended at the end, so the markdown heading assertPublishable
  // requires is untouched — but assert it rather than assume it.
  assert.doesNotThrow(() => assertPublishable(appendBatchMarker(GOOD_BODY, SHA_A), 'test'))
})

test('appending the marker is idempotent, and a no-sha run stamps nothing', () => {
  const body = `# heading\n\n${'x'.repeat(250)}`
  const once = appendBatchMarker(body, SHA_A)
  assert.equal(appendBatchMarker(once, SHA_A), once)
  assert.equal(appendBatchMarker(body, null), body)
})

test('bodyBatchSha reports null for a legacy body and ignores a lookalike', () => {
  assert.equal(bodyBatchSha('# a release\n\nno marker'), null)
  assert.equal(bodyBatchSha(''), null)
  assert.equal(bodyBatchSha(undefined), null)
  // Prose mentioning the marker's name is not a marker.
  assert.equal(bodyBatchSha('agentproto-batch: deadbeef in prose'), null)
})

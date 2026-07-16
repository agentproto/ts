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

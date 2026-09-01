/**
 * Guards the "Version Packages" PR changelog re-poster (#1072: changesets/action
 * dropped all 60 packages' changelogs from the body once it crossed GitHub's
 * size cap, leaving bare headings). The pure helpers here decide what gets
 * posted and how re-runs reconcile against comments already on the PR.
 *
 * Run: node --test scripts/version-pr-changelog.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  COMMENT_CAP,
  changelogSection,
  chunk,
  chunkHeader,
  marker,
  parseMarker,
  planComments,
  renderPackage,
} from './version-pr-changelog.mjs'

const CHANGELOG = `# @agentproto/tool-cli

## 0.2.2

### Patch Changes

- bd86fe4: Add npm package metadata fields (repository, bugs, homepage).

## 0.2.1

### Patch Changes

- older entry
`

test('changelogSection extracts exactly the requested version', () => {
  assert.equal(
    changelogSection(CHANGELOG, '0.2.2'),
    '### Patch Changes\n\n- bd86fe4: Add npm package metadata fields (repository, bugs, homepage).',
  )
  assert.equal(changelogSection(CHANGELOG, '0.2.1'), '### Patch Changes\n\n- older entry')
  assert.equal(changelogSection(CHANGELOG, '9.9.9'), '')
})

test('renderPackage collapses each package and keeps dependency-only bumps visible', () => {
  const withBody = renderPackage({ name: '@agentproto/tool-cli', version: '0.2.2', section: '- x' })
  assert.match(withBody, /<summary><b>@agentproto\/tool-cli@0\.2\.2<\/b><\/summary>/)
  assert.match(withBody, /\n- x\n/)
  const empty = renderPackage({ name: '@agentproto/wallet', version: '0.1.1', section: '' })
  assert.match(empty, /bumped by dependency/)
})

test('marker round-trips through parseMarker', () => {
  const sha = 'abcdef0123456789'
  const m = parseMarker(`${marker(2, 3, sha)}\n### body`)
  assert.deepEqual(m, { part: 2, total: 3, sha })
  assert.equal(parseMarker('plain comment'), null)
  assert.equal(parseMarker(undefined), null)
})

test('chunk packs parts under the cap and never drops one', () => {
  const parts = Array.from({ length: 10 }, (_, i) => `part-${i}-${'x'.repeat(30)}`)
  const chunks = chunk(parts, 100)
  assert.ok(chunks.length > 1)
  for (const c of chunks) assert.ok(c.length <= 100, `chunk over cap: ${c.length}`)
  const joined = chunks.join('\n\n')
  for (const p of parts) assert.ok(joined.includes(p), `missing ${p.slice(0, 8)}`)
})

test('chunk hard-cuts a single oversized part instead of losing it', () => {
  const huge = 'y'.repeat(500)
  const [only] = chunk([huge], 200)
  assert.ok(only.length <= 200)
  assert.match(only, /entry truncated at 200 chars/)
})

test('default cap leaves headroom under the 65 536-char comment limit', () => {
  assert.ok(COMMENT_CAP < 65_536 - 2_000)
  const header = chunkHeader({ part: 1, total: 1, packageCount: 60, sha: 'a'.repeat(40) })
  assert.ok(header.length < 2_000)
  assert.match(header, /^<!-- version-pr-changelog part=1\/1 sha=a{40} -->\n/)
  assert.doesNotMatch(header, /part 1\/1\)/) // single chunk → no "(part 1/1)" noise
  assert.match(chunkHeader({ part: 2, total: 3, packageCount: 1, sha: 'b'.repeat(40) }), /\(part 2\/3\)/)
})

test('planComments updates in place, creates the missing tail, deletes surplus', () => {
  const sha = 'c'.repeat(40)
  const existing = [
    { id: 30, body: `${marker(3, 3, sha)}\nstale-3` }, // left over from an older, larger run
    { id: 10, body: `${marker(1, 2, sha)}\nsame-1` },
    { id: 20, body: `${marker(2, 2, sha)}\nold-2` },
    { id: 99, body: 'unrelated human comment' },
  ]
  // Two chunks wanted: part 1 byte-identical, part 2 changed, stale part 3 gone.
  const bodies = [`${marker(1, 2, sha)}\nsame-1`, `${marker(2, 2, sha)}\nnew-2`]
  const plan = planComments(existing, bodies)
  assert.deepEqual(plan.unchanged, [10])
  assert.deepEqual(plan.update, [{ id: 20, body: bodies[1] }])
  assert.deepEqual(plan.create, [])
  assert.deepEqual(plan.remove, [30])
})

test('planComments creates everything on a fresh PR and removes everything when no chunks', () => {
  const sha = 'd'.repeat(40)
  const fresh = planComments([], ['a', 'b'])
  assert.deepEqual(fresh.create, ['a', 'b'])
  assert.deepEqual(fresh.update, [])
  const cleanup = planComments([{ id: 1, body: `${marker(1, 1, sha)}\nx` }], [])
  assert.deepEqual(cleanup.remove, [1])
  assert.deepEqual(cleanup.create, [])
})

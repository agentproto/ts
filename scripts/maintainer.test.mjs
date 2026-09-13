import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  matchGlob,
  firstEscalateHit,
  extractMergeCfg,
  truncateDiff,
  parseArgs,
  buildJudgePrompt,
  applyCiVeto,
} from './maintainer.mjs'

// ── matchGlob ──────────────────────────────────────────────────────────────

test('matchGlob: ** spans slashes, * does not', () => {
  assert.ok(matchGlob('packages/core/migrations/0001.sql', '**/migrations/**'))
  assert.ok(matchGlob('a/b.sql', '**/*.sql'))
  assert.equal(matchGlob('db.sql', '**/*.sql'), false) // `**/` requires at least one slash
  assert.ok(matchGlob('.github/workflows/ci.yml', '.github/workflows/**'))
  assert.equal(matchGlob('src/index.ts', '**/*.sql'), false)
})

// ── firstEscalateHit ─────────────────────────────────────────────────────────

const GLOBS = ['**/migrations/**', '**/*.sql', '**/auth/**', '.github/workflows/**', '**/*.env*']

test('firstEscalateHit: returns the offending file', () => {
  assert.equal(firstEscalateHit(['README.md', 'packages/x/db/schema.sql'], GLOBS), 'packages/x/db/schema.sql')
  assert.equal(firstEscalateHit(['packages/auth/token.ts'], GLOBS), 'packages/auth/token.ts')
  assert.equal(firstEscalateHit(['.github/workflows/ci.yml'], GLOBS), '.github/workflows/ci.yml')
})

test('firstEscalateHit: undefined when nothing matches', () => {
  assert.equal(firstEscalateHit(['scripts/maintainer.mjs', 'docs/x.md'], GLOBS), undefined)
})

test('firstEscalateHit: empty globs never escalates (a PR that emptied the policy still cannot self-approve — the base copy is what is passed in)', () => {
  assert.equal(firstEscalateHit(['packages/x/db/schema.sql'], []), undefined)
  assert.equal(firstEscalateHit(['packages/x/db/schema.sql']), undefined)
})

// ── extractMergeCfg ──────────────────────────────────────────────────────────

test('extractMergeCfg: reads the merge block', () => {
  const cfg = extractMergeCfg(JSON.stringify({ merge: { alwaysEscalateGlobs: ['**/*.sql'], auto: false } }))
  assert.deepEqual(cfg.alwaysEscalateGlobs, ['**/*.sql'])
})

test('extractMergeCfg: missing merge block → {}', () => {
  assert.deepEqual(extractMergeCfg(JSON.stringify({ other: 1 })), {})
})

test('extractMergeCfg: throws on non-JSON (caller decides fail-safe)', () => {
  assert.throws(() => extractMergeCfg('not json'))
})

// ── truncateDiff ─────────────────────────────────────────────────────────────

test('truncateDiff: caps at 16k chars', () => {
  assert.equal(truncateDiff('x'.repeat(20_000)).length, 16_000)
  assert.equal(truncateDiff('short').length, 5)
})

// ── parseArgs ────────────────────────────────────────────────────────────────

test('parseArgs: no args → local (CI mode)', () => {
  assert.deepEqual(parseArgs([]), { mode: 'local', pr: null })
})

test('parseArgs: --pr <n> and --pr=<n>', () => {
  assert.deepEqual(parseArgs(['--pr', '789']), { mode: 'pr', pr: 789 })
  assert.deepEqual(parseArgs(['--pr=42']), { mode: 'pr', pr: 42 })
})

test('parseArgs: --all', () => {
  assert.deepEqual(parseArgs(['--all']), { mode: 'all', pr: null })
})

test('parseArgs: bad --pr and unknown args throw', () => {
  assert.throws(() => parseArgs(['--pr', 'abc']))
  assert.throws(() => parseArgs(['--pr']))
  assert.throws(() => parseArgs(['--nope']))
})

// ── buildJudgePrompt ─────────────────────────────────────────────────────────

test('buildJudgePrompt: includes changed files and diff, and the escalate contract', () => {
  const { system, user } = buildJudgePrompt(['a.ts', 'b.ts'], 'DIFF-BODY')
  assert.match(system, /"decision": "merge" \| "escalate"/)
  assert.match(user, /a\.ts\nb\.ts/)
  assert.match(user, /DIFF-BODY/)
})

test('buildJudgePrompt: empty file list renders (none)', () => {
  const { user } = buildJudgePrompt([], '')
  assert.match(user, /Changed files:\n\(none\)/)
})

// ── applyCiVeto ──────────────────────────────────────────────────────────────

const MERGE = { decision: 'merge', criticality: 'low', reason: 'docs only' }
const GREEN = {
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  statusCheckRollup: [{ name: 'Build + test', status: 'COMPLETED', conclusion: 'SUCCESS' }],
}

test('applyCiVeto: green + mergeable passes the merge verdict through untouched', () => {
  assert.deepEqual(applyCiVeto(MERGE, GREEN), MERGE)
})

test('applyCiVeto: a failing check downgrades merge → escalate and names the check', () => {
  const v = applyCiVeto(MERGE, {
    ...GREEN,
    statusCheckRollup: [
      { name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { name: 'Build + test', status: 'COMPLETED', conclusion: 'FAILURE' },
    ],
  })
  assert.equal(v.decision, 'escalate')
  assert.match(v.reason, /Build \+ test/)
  assert.match(v.reason, /judge said: docs only/) // the original verdict is preserved for the human
})

test('applyCiVeto: a check still running is not a pass', () => {
  const v = applyCiVeto(MERGE, {
    ...GREEN,
    statusCheckRollup: [{ name: 'Build + test', status: 'IN_PROGRESS', conclusion: null }],
  })
  assert.equal(v.decision, 'escalate')
  assert.match(v.reason, /not settled/)
})

test('applyCiVeto: conflicts and unestablished mergeability escalate', () => {
  assert.equal(applyCiVeto(MERGE, { ...GREEN, mergeable: 'CONFLICTING' }).decision, 'escalate')
  assert.equal(applyCiVeto(MERGE, { ...GREEN, mergeStateStatus: 'DIRTY' }).decision, 'escalate')
  assert.equal(applyCiVeto(MERGE, { ...GREEN, mergeable: 'UNKNOWN' }).decision, 'escalate')
})

test('applyCiVeto: legacy status contexts carry no `status` and are judged on conclusion alone', () => {
  const v = applyCiVeto(MERGE, {
    ...GREEN,
    statusCheckRollup: [{ context: 'ci/legacy', state: 'SUCCESS', conclusion: 'SUCCESS' }],
  })
  assert.deepEqual(v, MERGE)
})

test('applyCiVeto: never upgrades — an escalate stays escalate however green the build', () => {
  const esc = { decision: 'escalate', criticality: 'high', reason: 'touches auth' }
  assert.deepEqual(applyCiVeto(esc, GREEN), esc)
})

test('applyCiVeto: missing rollup (no checks configured) still requires mergeability', () => {
  assert.deepEqual(applyCiVeto(MERGE, { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' }), MERGE)
  assert.equal(applyCiVeto(MERGE, {}).decision, 'escalate')
  assert.equal(applyCiVeto(MERGE, undefined).decision, 'escalate')
})

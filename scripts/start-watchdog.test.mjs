import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ESCALATION_LABEL, select } from './start-watchdog.mjs'

const NOW = Date.parse('2026-10-23T16:10:00.000Z')
const minutesAgo = (n) => new Date(NOW - n * 60_000).toISOString()

test('flags a session stuck past the threshold', () => {
  const all = [{ id: 'sess_stuck', status: 'starting', startedAt: minutesAgo(10), label: 'stuck-one' }]
  const { flagged } = select(all, NOW, 180_000, [])
  assert.deepEqual(flagged.map(c => c.id), ['sess_stuck'])
  assert.equal(flagged[0].stuckSec, 600)
})

test('does not flag a session younger than the threshold', () => {
  const all = [{ id: 'sess_fresh', status: 'starting', startedAt: minutesAgo(1) }]
  const { flagged } = select(all, NOW, 180_000, [])
  assert.deepEqual(flagged, [])
})

test('a session exactly at the threshold is not yet flagged (strict >)', () => {
  const all = [{ id: 'sess_exact', status: 'starting', startedAt: new Date(NOW - 180_000).toISOString() }]
  const { flagged } = select(all, NOW, 180_000, [])
  assert.deepEqual(flagged, [])
})

test('ignores non-starting sessions regardless of age', () => {
  const all = [
    { id: 'sess_running', status: 'running', startedAt: minutesAgo(999) },
    { id: 'sess_killed', status: 'killed', startedAt: minutesAgo(999) },
  ]
  const { flagged, starting } = select(all, NOW, 180_000, [])
  assert.deepEqual(flagged, [])
  assert.equal(starting, 0)
})

test('a missing or unparseable startedAt is never flagged (nothing to age it from)', () => {
  const all = [
    { id: 'sess_no_started', status: 'starting' },
    { id: 'sess_bad_started', status: 'starting', startedAt: 'not-a-date' },
  ]
  const { flagged, starting } = select(all, NOW, 180_000, [])
  assert.deepEqual(flagged, [])
  assert.equal(starting, 2)
})

test('protects this guard\'s own session id', () => {
  const all = [{ id: 'sess_self', status: 'starting', startedAt: minutesAgo(10) }]
  const { flagged } = select(all, NOW, 180_000, ['sess_self'])
  assert.deepEqual(flagged, [])
})

test('never flags its own escalation investigator, however long it has been starting', () => {
  const all = [{ id: 'sess_investigator', status: 'starting', startedAt: minutesAgo(999), label: ESCALATION_LABEL }]
  const { flagged } = select(all, NOW, 180_000, [])
  assert.deepEqual(flagged, [], 'a slow cold-provisioning investigator must not become a kill candidate for the next sweep')
})

test('never flags any start-watchdog-* labelled session, not just the exact escalation label', () => {
  const all = [{ id: 'sess_other', status: 'starting', startedAt: minutesAgo(999), label: 'start-watchdog-something-else' }]
  const { flagged } = select(all, NOW, 180_000, [])
  assert.deepEqual(flagged, [])
})

test('never flags a non-agent-cli session', () => {
  const all = [{ id: 'sess_pty', status: 'starting', startedAt: minutesAgo(999), kind: 'terminal' }]
  const { flagged } = select(all, NOW, 180_000, [])
  assert.deepEqual(flagged, [])
})

test('never flags a session still queued behind the daemon\'s concurrency limit', () => {
  const all = [
    { id: 'sess_queued', status: 'starting', startedAt: minutesAgo(999), provisioning: { state: 'queued' } },
  ]
  const { flagged } = select(all, NOW, 180_000, [])
  assert.deepEqual(flagged, [])
})

test('sorts flagged candidates stuck-longest first', () => {
  const all = [
    { id: 'sess_a', status: 'starting', startedAt: minutesAgo(4) },
    { id: 'sess_b', status: 'starting', startedAt: minutesAgo(10) },
    { id: 'sess_c', status: 'starting', startedAt: minutesAgo(7) },
  ]
  const { flagged } = select(all, NOW, 180_000, [])
  assert.deepEqual(flagged.map(c => c.id), ['sess_b', 'sess_c', 'sess_a'])
})

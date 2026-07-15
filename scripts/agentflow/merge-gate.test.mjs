import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decideMergeGate } from './merge-gate.mjs'

function decide(overrides = {}) {
  return decideMergeGate({
    draft: false,
    automergeVar: 'true', // today's actual repo var value
    cfg: { auto: true, requireAck: false, ackLabel: 'agentflow:ack' },
    changedFiles: ['packages/runtime/src/foo.ts'],
    reviewDecision: 'APPROVED',
    labels: [],
    ...overrides,
  })
}

// ── draft ⇒ never arm (this PR's addition on top of #343) ─────────────────
test('draft PR never arms, even fully approved with the switch on', () => {
  const result = decide({ draft: true })
  assert.equal(result.action, 'hold')
  assert.match(result.reason, /draft/i)
})

test('draft beats every other condition (regression for the 2026-07-15 incident)', () => {
  // This is exactly #336's shape: draft, APPROVED, var=true. Before this
  // change, the workflow attempted to arm and GitHub refused with a
  // GraphQL error that was swallowed. It must now be an explicit hold.
  const result = decideMergeGate({
    draft: true,
    automergeVar: 'true',
    cfg: { auto: true },
    changedFiles: [],
    reviewDecision: 'APPROVED',
    labels: [],
  })
  assert.equal(result.action, 'hold')
  assert.notEqual(result.action, 'arm')
})

// ── happy path ───────────────────────────────────────────────────────────
test('non-draft + var=true + not vetoed + APPROVED + no self-modification ⇒ arm', () => {
  const result = decide()
  assert.equal(result.action, 'arm')
})

// ── #343: the repo var is the only thing that can enable ──────────────────
test('var !== "true" disables, regardless of merge.auto', () => {
  for (const v of ['false', '', undefined, 'TRUE', '1']) {
    const result = decide({ automergeVar: v, cfg: { auto: true } })
    assert.equal(result.action, 'disabled', `automergeVar=${JSON.stringify(v)} should disable`)
  }
})

test('merge.auto=true alone (var not "true") does not enable', () => {
  const result = decide({ automergeVar: 'false', cfg: { auto: true } })
  assert.equal(result.action, 'disabled')
})

// ── #343: the policy may only veto, never grant ────────────────────────────
test('merge.auto=false vetoes even when var=true and PR is APPROVED', () => {
  const result = decide({ cfg: { auto: false } })
  assert.equal(result.action, 'disabled')
  assert.match(result.reason, /veto/i)
})

test('merge.auto absent (undefined) does not veto — only literal false does', () => {
  const result = decide({ cfg: {} })
  assert.equal(result.action, 'arm')
})

// ── #343: self-modification guard — "a PR cannot change how it is merged" ──
test('a PR that edits .github/agentic-review.json cannot change how it is merged', () => {
  const result = decide({ changedFiles: ['.github/agentic-review.json'] })
  assert.equal(result.action, 'escalate')
  assert.match(result.reason, /agentic-review\.json/)
})

test('a PR that edits .github/workflows/** always escalates (this PR included)', () => {
  const result = decide({ changedFiles: ['.github/workflows/ci.yml'] })
  assert.equal(result.action, 'escalate')
})

test('a PR that edits scripts/agentflow/** (merge-gate.mjs itself) escalates', () => {
  const result = decide({ changedFiles: ['scripts/agentflow/merge-gate.mjs'] })
  assert.equal(result.action, 'escalate')
})

test('a PR that edits scripts/maintainer.mjs escalates', () => {
  const result = decide({ changedFiles: ['scripts/maintainer.mjs'] })
  assert.equal(result.action, 'escalate')
})

test('a PR that edits .github/actions/** escalates', () => {
  const result = decide({ changedFiles: ['.github/actions/agent-setup/action.yml'] })
  assert.equal(result.action, 'escalate')
})

test('self-modification guard does not false-positive on unrelated paths', () => {
  const result = decide({
    changedFiles: ['docs/agentic-review.json.md', 'scripts/agentflow-notes.md', 'packages/runtime/src/foo.ts'],
  })
  assert.equal(result.action, 'arm')
})

test('self-modification guard is checked even when merge.auto is absent/true and var is set — it cannot be bypassed by the switch state', () => {
  const result = decide({ cfg: { auto: true }, changedFiles: ['.github/workflows/ci.yml'] })
  assert.equal(result.action, 'escalate')
})

// ── review decision lattice ──────────────────────────────────────────────
for (const decision of ['COMMENTED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED', '']) {
  test(`reviewDecision=${decision || '(empty)'} never arms`, () => {
    const result = decide({ reviewDecision: decision })
    assert.notEqual(result.action, 'arm')
    assert.equal(result.action, 'hold')
  })
}

// ── requireAck ⇒ hold for label ──────────────────────────────────────────
test('requireAck on + label absent ⇒ hold', () => {
  const result = decide({ cfg: { auto: true, requireAck: true, ackLabel: 'agentflow:ack' }, labels: [] })
  assert.equal(result.action, 'hold')
  assert.match(result.reason, /ack/i)
})

test('requireAck on + label present ⇒ arm', () => {
  const result = decide({
    cfg: { auto: true, requireAck: true, ackLabel: 'agentflow:ack' },
    labels: ['agentflow:ack'],
  })
  assert.equal(result.action, 'arm')
})

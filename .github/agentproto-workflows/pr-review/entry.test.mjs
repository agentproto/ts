import { test } from 'node:test'
import assert from 'node:assert/strict'
import workflow from './entry.mjs'

const prompt = (input) => workflow.steps[0].prompt({ input })

// ── host placement (default — unchanged behavior) ──────────────────────────

test('default placement (no reviewerSandbox, no repo) reviews via gh CLI', () => {
  const text = prompt({ prNumber: 42 })
  assert.match(text, /Your job: review PR #42 and post a structured GitHub review\./)
  assert.match(text, /gh pr review 42 --comment/)
  assert.doesNotMatch(text, /curl -sS -X POST/)
  assert.doesNotMatch(text, /LOCAL run/)
  assert.match(text, /Write a changeset/)
})

// ── sandbox placement (unchanged behavior) ──────────────────────────────────

test('reviewerSandbox + repo selects sandbox (curl REST) delivery', () => {
  const text = prompt({
    prNumber: 7,
    repo: 'agentproto/ts',
    reviewConfig: { reviewerSandbox: 'e2b' },
  })
  assert.match(text, /Phase 0: Workspace bootstrap/)
  assert.match(text, /curl -sS -X POST/)
  assert.doesNotMatch(text, /gh pr review 7 --comment/)
  assert.doesNotMatch(text, /LOCAL run/)
})

test('reviewerSandbox without repo falls back to host (no clone target)', () => {
  const text = prompt({ prNumber: 7, reviewConfig: { reviewerSandbox: 'e2b' } })
  assert.doesNotMatch(text, /Phase 0: Workspace bootstrap/)
  assert.match(text, /gh pr review 7 --comment/)
})

// ── local placement (new) ───────────────────────────────────────────────────

test('placement "local" never references gh, curl, or changesets', () => {
  const text = prompt({ placement: 'local' })
  assert.doesNotMatch(text, /\bgh pr review\b/)
  assert.doesNotMatch(text, /curl -sS/)
  assert.doesNotMatch(text, /Write a changeset/)
  assert.doesNotMatch(text, /\.changeset\/pr-/)
})

test('placement "local" runs without a prNumber and reviews the branch diff', () => {
  const text = prompt({ placement: 'local', baseRef: 'main' })
  assert.match(text, /LOCAL pre-push check/)
  assert.match(text, /git diff origin\/main\.\.\.HEAD/)
})

test('placement "local" instructs the agent to emit a single JSON verdict as its final message', () => {
  const text = prompt({ placement: 'local' })
  assert.match(text, /"conclusion": "approve" \| "request_changes"/)
  assert.match(text, /LAST thing you output/)
  assert.match(text, /no markdown fences, no prose/)
})

test('placement "local" wins even when reviewerSandbox + repo are also set', () => {
  const text = prompt({
    placement: 'local',
    prNumber: 7,
    repo: 'agentproto/ts',
    reviewConfig: { reviewerSandbox: 'e2b' },
  })
  assert.doesNotMatch(text, /Phase 0: Workspace bootstrap/)
  assert.doesNotMatch(text, /curl -sS -X POST/)
  assert.match(text, /LOCAL pre-push check/)
})

// ── declared inputs ──────────────────────────────────────────────────────────

test('placement input defaults to "host" and prNumber defaults to 0', () => {
  assert.equal(workflow.inputs.placement.default, 'host')
  assert.equal(workflow.inputs.prNumber.default, 0)
})

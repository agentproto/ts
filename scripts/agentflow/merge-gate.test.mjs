import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
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

// ── red build ⇒ never arm (regression for #379) ──────────────────────────
// decideMergeGate deliberately has no opinion on CI: whether the build passed
// is the workflow's to know, not this function's. So these assert the guard
// where it actually lives — the auto-merge job's `if` in ci.yml.
//
// #379 merged with `Build + test` red. Nothing was broken in merge-gate: the
// arming step delegates "wait for green" to GitHub's required checks, `main`
// has none, and so arming *is* merging. `always()` (needed so a skipped
// pr-review still reaches the gate) defeated the needs-failure skip that
// would otherwise have caught it.
function autoMergeJobBlock() {
  const ci = readFileSync(fileURLToPath(new URL('../../.github/workflows/ci.yml', import.meta.url)), 'utf8')
  const lines = ci.split('\n')
  const start = lines.findIndex((l) => l === '  auto-merge:')
  assert.notEqual(start, -1, 'ci.yml must define an `auto-merge` job')
  // Until the next job at the same indent (2 spaces, non-comment).
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((l) => /^ {2}[a-z0-9_-]+:\s*$/.test(l))
  return (end === -1 ? rest : rest.slice(0, end)).join('\n')
}

test('auto-merge names build-and-test in needs', () => {
  const block = autoMergeJobBlock()
  const needs = /^\s*needs:\s*\[(.+)\]/m.exec(block)
  assert.ok(needs, 'auto-merge must declare `needs`')
  const named = needs[1].split(',').map((s) => s.trim())
  assert.ok(
    named.includes('build-and-test'),
    `auto-merge must need build-and-test directly, not inherit it via pr-review (got: ${named.join(', ')})`,
  )
})

test('auto-merge refuses to arm unless build-and-test succeeded', () => {
  const block = autoMergeJobBlock()
  const guard = /needs\.build-and-test\.result\s*==\s*'success'/.test(block)
  assert.ok(
    guard,
    "auto-merge's `if` must require needs.build-and-test.result == 'success' — " +
      'with `always()` present, a failed dependency does not skip the job, and ' +
      'a red PR arms and merges (#379).',
  )
})

test('the green guard survives always()', () => {
  // Belt and braces: if someone drops always(), the needs-failure skip covers
  // us; if someone keeps always(), the explicit result check must be there.
  // Exactly one of those must hold — this fails only if BOTH are gone.
  const block = autoMergeJobBlock()
  const hasAlways = /always\(\)/.test(block)
  const hasGreenCheck = /needs\.build-and-test\.result\s*==\s*'success'/.test(block)
  assert.ok(!hasAlways || hasGreenCheck, 'always() without an explicit build-and-test success check re-opens #379')
})

// ── stale-base ⇒ never arm (regression for the #1300/#1302/#1303 race) ────
// `main` has no branch protection, so a PR's own green `Build + test` only
// proves its OWN tree was self-consistent — not that it still is once merged
// on top of whatever landed on `main` after its branch was last updated.
// #1302 predated #1303's fix, was never brought up to date, and merged with
// a generated bundle built from the pre-fix source: its `Build + test` run
// was legitimately green the whole time. `decideMergeGate` deliberately has
// no opinion on this (same split as the #379 CI-green guard above) — the
// mergeability check lives in the workflow, not the pure function.
test('auto-merge queries mergeStateStatus before arming', () => {
  const block = autoMergeJobBlock()
  assert.match(block, /mergeStateStatus/, 'auto-merge must check the PR\'s mergeStateStatus against its base')
})

test('auto-merge refuses to arm while the PR is BEHIND its base', () => {
  const block = autoMergeJobBlock()
  assert.match(block, /BEHIND/, 'auto-merge must recognize mergeStateStatus=BEHIND')
  const gateGuard = /steps\.gate\.outputs\.action\s*==\s*'arm'/.exec(block)
  assert.ok(gateGuard, 'auto-merge must still gate arming on merge-gate\'s own action')
  const behindGuard = /steps\.behind\.outputs\.behind\s*!=\s*'true'/.test(block)
  assert.ok(
    behindGuard,
    "auto-merge's `if` must require steps.behind.outputs.behind != 'true' before computing or acting on " +
      'the merge-gate decision — otherwise a PR behind main can still arm on a stale tree.',
  )
})

test('the behind guard reaches both the gate computation and the arming step', () => {
  const block = autoMergeJobBlock()
  const behindChecks = block.match(/steps\.behind\.outputs\.behind\s*!=\s*'true'/g) || []
  assert.ok(
    behindChecks.length >= 2,
    'steps.behind.outputs.behind must gate both "Compute merge-gate decision" and "Maintainer judgment + arm" ' +
      `(found ${behindChecks.length} occurrence(s)) — gating only one leaves a path to arm on a stale base`,
  )
})

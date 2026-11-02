import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import workflow, {
  buildReviewSummary,
  fixerModelFor,
  maxFixIterations,
  maxReviewIterations,
  maxTotalReviews,
  resolveMaxFixIterations,
  reviewVerdictSchema,
  stageDiagram,
  supervisedReviewStep,
} from './entry.mjs'
import { reviewerTurnRetryFor } from '../lib/sandbox-agent.mjs'
import { stageDiagram as sharedDiagram } from '../../../scripts/lib/review-run-summary.mjs'

// ── the supervised loop is a REAL multi-step graph ──────────────────────────
// These assertions fail on the pre-supervised single-step workflow: it had no
// loop, no fixer step and no re-review path inside one run.

const loop = workflow.steps[0]

test('the review is a supervised loop plus a final review, not a one-shot review', () => {
  assert.deepEqual(
    workflow.steps.map((s) => `${s.id}:${s.kind}`),
    ['supervised-review:loop', 'needs-final-review:branch', 'review:agent'],
  )
  assert.equal(loop.kind, 'loop')
  assert.equal(loop.id, 'supervised-review')
})

test('the loop body carries review, a changes-requested branch, and a fix step', () => {
  const ids = loop.steps.map((s) => s.id)
  assert.deepEqual(ids, ['review', 'needs-fix', 'fix'])
  const branch = loop.steps.find((s) => s.id === 'needs-fix')
  assert.equal(branch.kind, 'branch')
  assert.deepEqual(branch.branches, [
    { when: '$steps.review.output.conclusion == request_changes', next: 'fix' },
  ])
})

test('the loop re-runs the review after a fix (the re-review path)', () => {
  // The review step is INSIDE the loop body, so a fix is followed by another
  // review of the same step id, not by the end of the run.
  const reviewIndex = loop.steps.findIndex((s) => s.id === 'review')
  const fixIndex = loop.steps.findIndex((s) => s.id === 'fix')
  assert.ok(reviewIndex >= 0 && fixIndex > reviewIndex)
  assert.equal(loop.while, '$steps.review.output.conclusion != approve')
  assert.equal(loop.max_iterations, maxReviewIterations)
})

test('the trailing review-only pass runs only when the loop never approved', () => {
  const final = workflow.steps.find((s) => s.id === 'needs-final-review')
  assert.equal(final.kind, 'branch')
  assert.deepEqual(final.branches, [
    { when: '$steps.review.output.conclusion != approve', next: 'review' },
  ])
  // it targets the top-level review step, not a loop-body step
  const top = workflow.steps.find((s) => s.id === 'review')
  assert.equal(top.kind, 'agent')
  assert.equal(top.outputSchema, reviewVerdictSchema)
})

test('the loop is bounded by maxFixIterations from .github/agentic-review.json', () => {
  assert.equal(resolveMaxFixIterations({ maxFixIterations: 3 }), 3)
  assert.equal(resolveMaxFixIterations({ commands: { fix: { maxFixIterations: 1 } } }), 1)
  assert.equal(resolveMaxFixIterations({ maxFixIterations: -1 }), 3)
  assert.equal(resolveMaxFixIterations({}), 3)
  // each loop iteration is at most one fix round; the trailing pass adds one
  // review, so the non-converging case is N fixes and N + 1 reviews.
  assert.equal(maxReviewIterations, maxFixIterations)
  assert.equal(maxTotalReviews, maxFixIterations + 1)
  // this repo's committed config is 3
  assert.equal(maxFixIterations, 3)
})

// ── typed verdict contract (the branch reads a STEP OUTPUT, not prose) ──────

test('the review step declares an outputSchema accepting only a typed verdict', () => {
  const reviewStep = loop.steps.find((s) => s.id === 'review')
  assert.equal(reviewStep.outputSchema, reviewVerdictSchema)
  assert.equal(reviewVerdictSchema.safeParse({ conclusion: 'approve', summary: 'ok' }).success, true)
  assert.equal(
    reviewVerdictSchema.safeParse({
      conclusion: 'request_changes',
      summary: 'bugs',
      findings: [{ severity: 'high', file: 'a.ts', note: 'n' }],
    }).success,
    true,
  )
  assert.equal(reviewVerdictSchema.safeParse({ conclusion: 'lgtm', summary: 'x' }).success, false)
  assert.equal(reviewVerdictSchema.safeParse('approved').success, false)
})

// ── prompts ─────────────────────────────────────────────────────────────────

const reviewPrompt = (bindings) =>
  loop.steps.find((s) => s.id === 'review').prompt({ input: { prNumber: 42 }, ...bindings })
const fixPrompt = (bindings) =>
  loop.steps.find((s) => s.id === 'fix').prompt({ input: { prNumber: 42 }, ...bindings })

test('the first-pass review posts with gh on the host and ends with the typed verdict', () => {
  const text = reviewPrompt({})
  assert.match(text, /gh pr review 42/)
  assert.doesNotMatch(text, /curl -sS/)
  assert.match(text, /End your turn with ONLY a JSON object/)
  assert.match(text, /conclusion/)
  assert.match(text, /node scripts\/list-changed-packages\.mjs/)
})

test('a re-review sees the fixer working tree (uncommitted edits)', () => {
  const bindings = {
    steps: {
      review: {
        output: {
          conclusion: 'request_changes',
          summary: 'needs a fix',
          findings: [{ severity: 'high', file: 'a.ts', note: 'bug' }],
        },
      },
      fix: { sessionId: 'sess_fix', text: 'fixed' },
    },
  }
  const text = reviewPrompt(bindings)
  assert.match(text, /Re-review after a fix/)
  assert.match(text, /git status --porcelain/)
  assert.match(text, /UNCOMMITTED edits/)
  // no changeset churn on a re-review
  assert.doesNotMatch(text, /node scripts\/list-changed-packages\.mjs/)
})

test('the fixer applies exactly the prior verdict findings and never commits/pushes', () => {
  const text = fixPrompt({
    steps: { review: { output: { conclusion: 'request_changes', summary: 's', findings: [{ note: 'fix me' }] } } } ,
  })
  assert.match(text, /fix me/)
  assert.match(text, /Do NOT commit, do NOT push/)
  assert.match(text, /calling job commits and pushes/)
})

test('the fixer resolves its own model override, else the reviewer model', () => {
  assert.equal(fixerModelFor({ reviewerModel: 'r', commands: { fix: { reviewerModel: 'f' } } }), 'f')
  assert.equal(fixerModelFor({ reviewerModel: 'r' }), 'r')
  assert.equal(fixerModelFor({}), undefined)
})

// ── summary builder (check run title + stage table) ─────────────────────────

const run = {
  status: 'done',
  stages: [
    {
      index: 0,
      status: 'done',
      steps: [
        {
          id: 'review',
          status: 'done',
          output: { sessionId: 's1', output: { conclusion: 'request_changes', summary: '2 bugs', findings: [{ note: 'a' }, { note: 'b' }] } },
        },
        { id: 'needs-fix', status: 'done' },
        { id: 'fix', status: 'done', output: { sessionId: 's2', text: 'fixed' } },
        { id: 'review', status: 'done', output: { sessionId: 's3', output: { conclusion: 'approve', summary: 'fixed' } } },
      ],
    },
  ],
}

test('buildReviewSummary lists every stage and the final verdict', () => {
  const out = buildReviewSummary(run)
  assert.equal(out.title, 'Agentic review: approved')
  assert.equal(out.verdict, 'approved')
  assert.equal(out.reviews, 2)
  assert.equal(out.fixes, 1)
  assert.match(out.summary, /\| review \| review \| done \| request_changes - 2 bugs \|/)
  assert.match(out.summary, /\| review \| review \| done \| approve - fixed \|/)
  assert.match(out.summary, /final verdict: APPROVED/)
  assert.match(out.summary, /Stage diagram:/)
})

test('buildReviewSummary counts every loop iteration from the run event log', () => {
  const events = [
    { seq: 1, type: 'step.started', stepId: 'review' },
    { seq: 2, type: 'step.succeeded', stepId: 'review' },
    { seq: 3, type: 'step.started', stepId: 'needs-fix' },
    { seq: 4, type: 'step.succeeded', stepId: 'needs-fix' },
    { seq: 5, type: 'step.started', stepId: 'fix' },
    { seq: 6, type: 'step.succeeded', stepId: 'fix' },
    { seq: 7, type: 'step.started', stepId: 'review' },
    { seq: 8, type: 'step.succeeded', stepId: 'review' },
    { seq: 9, type: 'step.started', stepId: 'fix' },
    { seq: 10, type: 'step.succeeded', stepId: 'fix' },
    { seq: 11, type: 'step.started', stepId: 'review' },
    { seq: 12, type: 'step.succeeded', stepId: 'review' },
  ]
  const out = buildReviewSummary(run, { events })
  assert.equal(out.reviews, 3)
  assert.equal(out.fixes, 2)
  assert.equal(out.verdict, 'approved')
  // The last review row carries the folded verdict even though the event log
  // itself has no payload.
  const rows = out.summary.split('\n').filter((l) => l.startsWith('| review |'))
  assert.equal(rows.length, 3)
  assert.match(rows[rows.length - 1], /approve - fixed/)
})

test('buildReviewSummary never reads a missing verdict as approval', () => {
  const out = buildReviewSummary({ status: 'done', stages: [{ steps: [{ id: 'fix', status: 'done' }] }] })
  assert.equal(out.verdict, 'incomplete')
  assert.equal(out.reviews, 0)
  const failed = buildReviewSummary({ status: 'failed', stages: [] })
  assert.equal(failed.verdict, 'failed')
  assert.equal(failed.title, 'Agentic review: run failed')
})

test('the stage diagram names the fix + re-review loop and its bound', () => {
  assert.match(stageDiagram(3), /fix -> re-review/)
  assert.match(stageDiagram(3), /3 fix round/)
  assert.equal(stageDiagram(3), sharedDiagram(3))
  assert.equal(stageDiagram(0), sharedDiagram(0))
})

// ── turn-retry fallback on the host sessions ────────────────────────────────
// The supervised review, the fixer and the trailing review are HOST sessions
// (no placement ladder). They must still get the same reviewerTurnRetry policy
// the box path uses, through the same lib helper. These fail on a workflow whose
// agent steps declare no `turnRetry`.

const FLASH = 'opencode-go/deepseek-v4.1-flash'
const reviewConfig = JSON.parse(readFileSync(new URL('../../agentic-review.json', import.meta.url), 'utf8'))
const ENV_KEYS = ['OPENCODE_GO_API_KEY', 'AGENT_ALLOWED_METERED_MODELS', 'OPENCODE_CONFIG_CONTENT', 'COMPUTER_CONTROLLER_URL']
const withEnv = (vars, fn) => {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  for (const k of ENV_KEYS) delete process.env[k]
  Object.assign(process.env, vars)
  try {
    return fn()
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  }
}
const GO_ENV = { OPENCODE_GO_API_KEY: 'go-key', AGENT_ALLOWED_METERED_MODELS: FLASH }
const TRANSIENT = ['rate-limit', 'upstream-5xx', 'no-output-stall']
const hostSteps = [
  ['review', loop.steps.find((s) => s.id === 'review')],
  ['fix', loop.steps.find((s) => s.id === 'fix')],
  ['final review', workflow.steps.find((s) => s.id === 'review')],
]
const bindings = (input) => ({ input: { prNumber: 7, ...input } })

test('every agent step of the supervised workflow declares a turnRetry selector', () => {
  for (const [name, st] of hostSteps) assert.equal(typeof st.turnRetry, 'function', name)
})

test('host steps get the one policy from agentic-review.json, via the shared helper', () => {
  withEnv(GO_ENV, () => {
    const b = bindings({ reviewConfig })
    for (const [name, st] of hostSteps) {
      const policy = st.turnRetry(b)
      assert.deepEqual(policy, reviewerTurnRetryFor(reviewConfig, name === 'fix' ? 'fix' : 'review'), name)
      assert.deepEqual(policy, reviewConfig.reviewerTurnRetry, name)
      assert.deepEqual(policy.fallback, [{ model: FLASH }], name)
      assert.equal(policy.on.includes('usage-limit'), true, name)
    }
  })
})

test('the policy is a superset of the box default: transient classes, maxRetries and free rotation survive', () => {
  withEnv(GO_ENV, () => {
    const policy = loop.steps.find((s) => s.id === 'review').turnRetry(bindings({ reviewConfig }))
    for (const cls of TRANSIENT) assert.equal(policy.on.includes(cls), true, cls)
    assert.equal(policy.maxRetries, 6)
    assert.deepEqual(policy.rotateOn, TRANSIENT)
    assert.equal(policy.rotate.length, 3)
  })
})

test('without the allowlist entry or the Go key the paid fallback is dropped, the rest stays', () => {
  for (const env of [{ OPENCODE_GO_API_KEY: 'go-key' }, { AGENT_ALLOWED_METERED_MODELS: FLASH }, {}]) {
    withEnv(env, () => {
      const policy = loop.steps.find((s) => s.id === 'fix').turnRetry(bindings({ reviewConfig }))
      assert.equal(policy.fallback, undefined, JSON.stringify(env))
      for (const cls of TRANSIENT) assert.equal(policy.on.includes(cls), true)
    })
  }
})

test('with the Go key and allowlist, the inline opencode config wires OPENCODE_GO_API_KEY by name only', () => {
  withEnv(GO_ENV, () => {
    loop.steps.find((s) => s.id === 'review').turnRetry(bindings({ reviewConfig }))
    const cfg = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT)
    assert.equal(cfg.provider['opencode-go'].options.apiKey, '{env:OPENCODE_GO_API_KEY}')
    assert.equal(process.env.OPENCODE_CONFIG_CONTENT.includes('go-key'), false)
  })
})

test('a config with no reviewerTurnRetry, or a claude-cloud opt-out, yields no policy', () => {
  assert.equal(loop.steps.find((s) => s.id === 'review').turnRetry(bindings({})), undefined)
  const claude = { ...reviewConfig, ...reviewConfig.agentPresets['claude-cloud'] }
  withEnv(GO_ENV, () => {
    for (const [, st] of hostSteps) assert.equal(st.turnRetry(bindings({ reviewConfig: claude })), null)
  })
})

test('host steps carry no placement ladder (that is the box lanes only)', () => {
  for (const [name, st] of hostSteps) assert.equal(st.placement, undefined, name)
})

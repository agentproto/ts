import { strict as assert } from 'node:assert'
import test from 'node:test'

import { describeRunProgress } from './workflow-progress.mjs'

test('reports the run status even with no stages', () => {
  assert.equal(describeRunProgress({ status: 'running', stages: [] }), 'status=running')
})

test('tolerates a missing/garbage run (fed straight from an MCP tool result)', () => {
  assert.equal(describeRunProgress(undefined), 'status=?')
  assert.equal(describeRunProgress({}), 'status=?')
  assert.equal(describeRunProgress({ status: 'running', stages: 'nope' }), 'status=running')
})

test('names the running step and its session — the whole point of the heartbeat', () => {
  const line = describeRunProgress({
    status: 'running',
    stages: [
      {
        index: 0,
        label: 'review',
        status: 'running',
        steps: [
          { index: 0, label: 'bootstrap', status: 'done' },
          { index: 1, label: 'reviewer', status: 'running', sessionId: 'sess_ab12' },
          { index: 2, label: 'deliver', status: 'pending' },
        ],
      },
    ],
  })
  assert.equal(line, 'status=running · stage0(review)=running [1/3] running=reviewer@sess_ab12')
})

test('omits the running= clause when nothing is running', () => {
  const line = describeRunProgress({
    status: 'running',
    stages: [{ index: 0, status: 'pending', steps: [{ index: 0, label: 'a', status: 'pending' }] }],
  })
  assert.equal(line, 'status=running · stage0=pending [0/1]')
})

test('changes when — and only when — progress actually moves', () => {
  const at = (stepStatus) => ({
    status: 'running',
    stages: [{ index: 0, status: 'running', steps: [{ index: 0, label: 'x', status: stepStatus }] }],
  })
  // Same state polled twice ⇒ identical fingerprint ⇒ the driver stays quiet.
  assert.equal(describeRunProgress(at('running')), describeRunProgress(at('running')))
  assert.notEqual(describeRunProgress(at('running')), describeRunProgress(at('done')))
})

// ── optional second-arg `context` (adapter/model/sandbox/turn detail) ──────
// `describeRunProgress` cannot derive any of this from a WorkflowRun alone
// (workflow_status's step rows carry only index/label/status/sessionId/
// phase/timestamps) — it is out-of-band detail a caller (the driver) already
// knows or looked up separately. Omitting `context` must reproduce the exact
// pre-existing string, unchanged.

const RUNNING_REVIEWER_RUN = {
  status: 'running',
  stages: [
    {
      index: 0,
      label: 'review',
      status: 'running',
      steps: [{ index: 0, label: 'reviewer', status: 'running', sessionId: 'sess_ab12' }],
    },
  ],
}

test('regression: no context arg (or an empty one) reproduces the exact pre-existing fingerprint', () => {
  const bare = describeRunProgress(RUNNING_REVIEWER_RUN)
  assert.equal(bare, 'status=running · stage0(review)=running [0/1] running=reviewer@sess_ab12')
  assert.equal(describeRunProgress(RUNNING_REVIEWER_RUN, {}), bare)
  assert.equal(describeRunProgress(RUNNING_REVIEWER_RUN, undefined), bare)
})

test('context.sessions enriches the running step with sandbox placement and turn count', () => {
  const line = describeRunProgress(RUNNING_REVIEWER_RUN, {
    maxReviewTurns: 50,
    sessions: {
      sess_ab12: { sandboxProvider: 'e2b', sandboxId: 'sbx_1', adapterSlug: 'claude-code', turnsCompleted: 3 },
    },
  })
  assert.equal(
    line,
    'status=running · stage0(review)=running [0/1] running=reviewer@sess_ab12(sandbox=e2b:sbx_1,adapter=claude-code,turn=3/50)',
  )
})

test('turn count renders without a /max suffix when maxReviewTurns is unknown', () => {
  const line = describeRunProgress(RUNNING_REVIEWER_RUN, {
    sessions: { sess_ab12: { turnsCompleted: 3 } },
  })
  assert.match(line, /turn=3(?!\/)/)
})

test('a session with no matching context.sessions entry stays unenriched', () => {
  const line = describeRunProgress(RUNNING_REVIEWER_RUN, { sessions: { sess_other: { turnsCompleted: 9 } } })
  assert.equal(line, 'status=running · stage0(review)=running [0/1] running=reviewer@sess_ab12')
})

test('run-level adapter/model/cliSource/reviewerSessionId are appended once, after the stage/awaiting fields', () => {
  const line = describeRunProgress(RUNNING_REVIEWER_RUN, {
    adapter: 'claude-code',
    model: 'openrouter/z-ai/glm-5.3-flash',
    cliSource: 'workspace',
    reviewerSessionId: 'sess_ab12',
  })
  assert.equal(
    line,
    'status=running · stage0(review)=running [0/1] running=reviewer@sess_ab12 · ' +
      'reviewer=sess_ab12 · adapter=claude-code · model=openrouter/z-ai/glm-5.3-flash · cliSource=workspace',
  )
})

// ── tool-call count / tokens / elapsed (SANDBOX-VISIBILITY-JOIN #4) ────────
// toolCallsThisTurn/tokensIn/tokensOut ride on the SAME session_list summary
// the driver already fetches for sandbox/adapter/turn detail — no extra
// session_usage lookup. Elapsed is derived from the step's own `startedAt`,
// already on the run object.

test('context.sessions enriches the running step with tool-call count and tokens', () => {
  const line = describeRunProgress(RUNNING_REVIEWER_RUN, {
    sessions: { sess_ab12: { turnsCompleted: 3, toolCallsThisTurn: 7, tokensIn: 12_345, tokensOut: 890 } },
  })
  assert.equal(
    line,
    'status=running · stage0(review)=running [0/1] running=reviewer@sess_ab12(turn=3,tools=7,tokens=12.3kin/890out)',
  )
})

test('tokens renders even when only one side (in or out) is known — the other reads as 0', () => {
  const line = describeRunProgress(RUNNING_REVIEWER_RUN, { sessions: { sess_ab12: { tokensIn: 500 } } })
  assert.match(line, /tokens=500in\/0out/)
})

test('large token counts are compacted (k/M) to keep the heartbeat line short', () => {
  const line = describeRunProgress(RUNNING_REVIEWER_RUN, {
    sessions: { sess_ab12: { tokensIn: 2_500_000, tokensOut: 999 } },
  })
  assert.match(line, /tokens=2\.5Min\/999out/)
})

test('elapsed is computed from the running step\'s own startedAt — no context needed', () => {
  const run = {
    status: 'running',
    stages: [
      {
        index: 0,
        label: 'review',
        status: 'running',
        steps: [
          {
            index: 0,
            label: 'reviewer',
            status: 'running',
            sessionId: 'sess_ab12',
            startedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      },
    ],
  }
  const now = Date.parse('2026-01-01T00:02:05.000Z') // +2m5s
  const line = describeRunProgress(run, undefined, now)
  assert.equal(line, 'status=running · stage0(review)=running [0/1] running=reviewer@sess_ab12(elapsed=2m5s)')
})

test('elapsed combines with sandbox/turn/tool/token detail in one parenthesized group', () => {
  const run = {
    status: 'running',
    stages: [
      {
        index: 0,
        label: 'review',
        status: 'running',
        steps: [
          {
            index: 0,
            label: 'reviewer',
            status: 'running',
            sessionId: 'sess_ab12',
            startedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      },
    ],
  }
  const now = Date.parse('2026-01-01T01:00:00.000Z') // +1h
  const line = describeRunProgress(
    run,
    { maxReviewTurns: 50, sessions: { sess_ab12: { turnsCompleted: 3, toolCallsThisTurn: 2 } } },
    now,
  )
  assert.equal(
    line,
    'status=running · stage0(review)=running [0/1] running=reviewer@sess_ab12(turn=3/50,tools=2,elapsed=1h0m)',
  )
})

test('a missing/garbage startedAt is silently omitted rather than producing "elapsed=NaNs"', () => {
  const run = {
    status: 'running',
    stages: [
      {
        index: 0,
        status: 'running',
        steps: [{ index: 0, label: 'x', status: 'running', sessionId: 's1', startedAt: 'not-a-date' }],
      },
    ],
  }
  const line = describeRunProgress(run)
  assert.equal(line, 'status=running · stage0=running [0/1] running=x@s1')
})

test('surfaces the human-in-the-loop parks that look identical to a hang', () => {
  const approval = describeRunProgress({
    status: 'awaiting-approval',
    stages: [],
    awaitingApproval: { approvalId: 'appr_9', stepId: 's1', prompt: 'ok?', since: 'now' },
  })
  assert.equal(approval, 'status=awaiting-approval · awaitingApproval=appr_9')

  const suspend = describeRunProgress({
    status: 'awaiting-input',
    stages: [],
    awaitingSuspend: { stepId: 's1', on: ['pr.merged', 'pr.closed'] },
  })
  assert.equal(suspend, 'status=awaiting-input · awaitingSuspend=pr.merged|pr.closed')
})

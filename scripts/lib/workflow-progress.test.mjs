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

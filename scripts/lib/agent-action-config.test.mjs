import assert from 'node:assert/strict'
import test from 'node:test'
import { githubOutputs, resolveAgentAction, toReviewConfig } from './agent-action-config.mjs'

const config = {
  blocking: true,
  agentPresets: {
    mimo: { reviewerAdapter: 'opencode', reviewerModel: 'opencode/mimo-free' },
    step: { reviewerAdapter: 'opencode', reviewerModel: 'opencode/step-free' },
    cloud: { cloud: 'anthropic', reviewerAdapter: 'claude-code-cloud' },
  },
  agentActions: {
    review: { env: 'AGENT_REVIEW_PRESETS', presets: ['mimo', 'step'] },
  },
}

test('uses the action default chain and materializes review fallbacks', () => {
  const resolved = resolveAgentAction(config, 'review', {})
  assert.deepEqual(resolved.names, ['mimo', 'step'])
  const review = toReviewConfig(config, resolved)
  assert.equal(review.reviewerModel, 'opencode/mimo-free')
  assert.deepEqual(review.reviewerFallbackModels, ['opencode/step-free'])
  assert.deepEqual(review.resolvedAgentAction.presets, ['mimo', 'step'])
})

test('the action-specific env swaps and reorders presets', () => {
  const resolved = resolveAgentAction(config, 'review', { AGENT_REVIEW_PRESETS: 'step, mimo' })
  assert.deepEqual(resolved.names, ['step', 'mimo'])
  assert.equal(githubOutputs(resolved).primary_model, 'opencode/step-free')
})

test('claude-cloud force selects the cloud preset without a sandbox fallback', () => {
  const resolved = resolveAgentAction(config, 'review', {}, 'claude-cloud')
  assert.deepEqual(resolved.names, ['cloud'])
  assert.equal(githubOutputs(resolved).backend, 'claude-cloud')
})

test('unknown presets fail with an actionable error', () => {
  assert.throws(() => resolveAgentAction(config, 'review', { AGENT_REVIEW_PRESETS: 'missing' }), /unknown preset: missing/)
})

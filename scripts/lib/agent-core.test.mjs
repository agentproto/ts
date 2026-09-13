import { strict as assert } from 'node:assert'
import test from 'node:test'

import { runAgentLoop } from './agent-core.mjs'

/**
 * Queue canned Messages API responses and capture the request bodies.
 * `callClaude` talks to `fetch` directly, so that is the seam.
 */
function stubAnthropic(responses) {
  const requests = []
  const original = globalThis.fetch
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(init.body))
    const next = responses.shift()
    if (!next) throw new Error('stubAnthropic: more API calls than queued responses')
    return { ok: true, json: async () => next }
  }
  return { requests, restore: () => { globalThis.fetch = original } }
}

const text = (t) => ({ type: 'text', text: t })
const toolUse = (name, input) => ({ type: 'tool_use', id: `tu_${name}`, name, input })

const BASE = { apiKey: 'sk-test', model: 'claude-sonnet-5', system: 's', tools: [], userPrompt: 'go' }

test('a max_tokens turn is retried, not mistaken for the model being finished', async () => {
  // The #1297 shape: the model burns the whole budget drafting the mandatory
  // tool call, so the response carries neither a tool_use nor usable text. The
  // old loop read "no tool uses ⇒ done" and returned a clean empty result.
  const calls = []
  const stub = stubAnthropic([
    { content: [text('## Summary\nthis review body got cut off mid-')], stop_reason: 'max_tokens' },
    { content: [toolUse('gh_pr_review', { event: 'APPROVE' })], stop_reason: 'tool_use' },
    { content: [text('posted')], stop_reason: 'end_turn' },
  ])
  try {
    const result = await runAgentLoop({
      ...BASE,
      toolImpls: { gh_pr_review: async (input) => { calls.push(input); return 'ok' } },
    })
    assert.deepEqual(calls, [{ event: 'APPROVE' }], 'the retry must reach the mandatory tool call')
    assert.equal(result.finalText, 'posted')
    assert.equal(result.maxedOut, false)
  } finally {
    stub.restore()
  }
})

test('the truncated turn is dropped and the user turn carries a be-terse rider', async () => {
  const stub = stubAnthropic([
    { content: [text('half a thought')], stop_reason: 'max_tokens' },
    { content: [text('done')], stop_reason: 'end_turn' },
  ])
  try {
    const result = await runAgentLoop({ ...BASE, toolImpls: {} })
    // Never keep the partial assistant turn: a truncated tool_use would leave a
    // dangling tool_use with no tool_result (API error on the next call).
    assert.equal(
      result.messages.filter((m) => m.role === 'assistant' && JSON.stringify(m.content).includes('half a thought')).length,
      0,
    )
    // The retry re-asks the SAME user turn, annotated with why.
    const retryBody = stub.requests[1]
    const userTurn = retryBody.messages[0]
    assert.equal(userTurn.role, 'user')
    assert.equal(userTurn.content[0].text, 'go')
    assert.match(userTurn.content[1].text, /cut off/)
    assert.match(userTurn.content[1].text, /SHORT/)
  } finally {
    stub.restore()
  }
})

test('a truncated turn NEVER executes its tool calls (half-parsed input)', async () => {
  // A tool_use cut off mid-JSON can arrive with partial input. Posting a review
  // from it would be worse than not posting at all.
  const calls = []
  const stub = stubAnthropic([
    { content: [toolUse('gh_pr_review', { body: '## Summ' })], stop_reason: 'max_tokens' },
    { content: [text('gave up cleanly')], stop_reason: 'end_turn' },
  ])
  try {
    await runAgentLoop({
      ...BASE,
      toolImpls: { gh_pr_review: async (input) => { calls.push(input); return 'ok' } },
    })
    assert.deepEqual(calls, [])
  } finally {
    stub.restore()
  }
})

test('repeated truncation throws instead of returning a success-shaped empty result', async () => {
  const stub = stubAnthropic([
    { content: [text('a')], stop_reason: 'max_tokens' },
    { content: [text('b')], stop_reason: 'max_tokens' },
    { content: [text('c')], stop_reason: 'max_tokens' },
  ])
  try {
    await assert.rejects(
      runAgentLoop({ ...BASE, toolImpls: {}, maxTruncationRetries: 2 }),
      /truncated by max_tokens/,
    )
  } finally {
    stub.restore()
  }
})

test('onResponse surfaces stop_reason for every turn', async () => {
  const seen = []
  const stub = stubAnthropic([
    { content: [toolUse('git_log', {})], stop_reason: 'tool_use' },
    { content: [text('fin')], stop_reason: 'end_turn' },
  ])
  try {
    await runAgentLoop({
      ...BASE,
      toolImpls: { git_log: async () => 'log' },
      onResponse: (r) => seen.push(r),
    })
    assert.deepEqual(seen, [
      { turn: 1, stopReason: 'tool_use', toolNames: ['git_log'], textChars: 0 },
      { turn: 2, stopReason: 'end_turn', toolNames: [], textChars: 3 },
    ])
  } finally {
    stub.restore()
  }
})

test('an ordinary end_turn still returns its text (regression)', async () => {
  const stub = stubAnthropic([{ content: [text('all good')], stop_reason: 'end_turn' }])
  try {
    const result = await runAgentLoop({ ...BASE, toolImpls: {} })
    assert.equal(result.finalText, 'all good')
    assert.equal(result.turns, 1)
    assert.equal(result.maxedOut, false)
  } finally {
    stub.restore()
  }
})

test('maxTurns still caps the loop', async () => {
  const stub = stubAnthropic(
    Array.from({ length: 3 }, () => ({ content: [toolUse('git_log', {})], stop_reason: 'tool_use' })),
  )
  try {
    const result = await runAgentLoop({
      ...BASE,
      toolImpls: { git_log: async () => 'log' },
      maxTurns: 3,
    })
    assert.equal(result.maxedOut, true)
    assert.equal(result.turns, 3)
  } finally {
    stub.restore()
  }
})

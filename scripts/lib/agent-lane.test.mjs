/**
 * Lane isolation is the whole point: a lane must never inherit another lane's
 * credential or routing var, or the claude CLI silently bills the wrong
 * account (API key out-ranks OAuth) or a gateway 401s on a native key.
 *
 * Run: node --test scripts/lib/agent-lane.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  AUTO_ORDER,
  LANES,
  MOONSHOT_ANTHROPIC_BASE_URL,
  OPENROUTER_ANTHROPIC_BASE_URL,
  describeLane,
  laneAvailable,
  pickLane,
  resolveLane,
} from './agent-lane.mjs'

const EVERYTHING = {
  ANTHROPIC_API_KEY: 'sk-native',
  CLAUDE_CODE_OAUTH_TOKEN: 'oauth-main',
  CLAUDE_CODE_OAUTH_TOKEN_FALLBACK: 'oauth-fallback',
  OPENROUTER_API_KEY: 'or-key',
  MOONSHOT_API_KEY: 'ms-key',
  ANTHROPIC_BASE_URL: 'https://stale.example',
  CLAUDE_CODE_USE_BEDROCK: '1',
  PATH: '/usr/bin',
}

test('subscription lane keeps only its OAuth token and scrubs the API key + gateway vars', () => {
  const r = resolveLane('subscription', EVERYTHING)
  assert.equal(r.missing, null)
  assert.equal(r.env.CLAUDE_CODE_OAUTH_TOKEN, 'oauth-main')
  assert.equal(r.env.ANTHROPIC_API_KEY, undefined)
  assert.equal(r.env.ANTHROPIC_BASE_URL, undefined)
  assert.equal(r.env.ANTHROPIC_AUTH_TOKEN, undefined)
  assert.equal(r.env.CLAUDE_CODE_USE_BEDROCK, undefined)
  assert.equal(r.env.PATH, '/usr/bin') // unrelated env passes through
  assert.equal(r.model, 'claude-sonnet-4-6')
  assert.equal(r.thinking, false)
})

test('subscription-fallback maps the FALLBACK secret onto CLAUDE_CODE_OAUTH_TOKEN', () => {
  const r = resolveLane('subscription-fallback', EVERYTHING)
  assert.equal(r.env.CLAUDE_CODE_OAUTH_TOKEN, 'oauth-fallback')
  assert.equal(r.env.CLAUDE_CODE_OAUTH_TOKEN_FALLBACK, 'oauth-fallback') // harmless passthrough
  assert.equal(r.env.ANTHROPIC_API_KEY, undefined)
})

test('openrouter lane is a gateway spawn: base_url + bearer, no native key, model pinned', () => {
  const r = resolveLane('openrouter', EVERYTHING)
  assert.equal(r.env.ANTHROPIC_BASE_URL, OPENROUTER_ANTHROPIC_BASE_URL)
  assert.equal(r.env.ANTHROPIC_AUTH_TOKEN, 'or-key')
  assert.equal(r.env.ANTHROPIC_API_KEY, undefined)
  assert.equal(r.env.CLAUDE_CODE_OAUTH_TOKEN, undefined)
  assert.equal(r.env.ANTHROPIC_MODEL, 'anthropic/claude-sonnet-4.6')
  assert.equal(r.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'anthropic/claude-sonnet-4.6')
  assert.equal(r.thinking, false)
})

test('moonshot lane pins kimi, requires thinking, accepts ANTHROPIC_AUTH_TOKEN as the bearer', () => {
  const r = resolveLane('moonshot', EVERYTHING)
  assert.equal(r.env.ANTHROPIC_BASE_URL, MOONSHOT_ANTHROPIC_BASE_URL)
  assert.equal(r.env.ANTHROPIC_AUTH_TOKEN, 'ms-key')
  assert.equal(r.model, 'kimi-k2.7-code')
  assert.equal(r.thinking, true)
  const viaBearer = resolveLane('moonshot', { ANTHROPIC_AUTH_TOKEN: 'bearer-only' })
  assert.equal(viaBearer.env.ANTHROPIC_AUTH_TOKEN, 'bearer-only')
})

test('api-key lane keeps only ANTHROPIC_API_KEY', () => {
  const r = resolveLane('api-key', EVERYTHING)
  assert.equal(r.env.ANTHROPIC_API_KEY, 'sk-native')
  assert.equal(r.env.CLAUDE_CODE_OAUTH_TOKEN, undefined)
  assert.equal(r.env.ANTHROPIC_BASE_URL, undefined)
})

test('a lane whose credential is absent reports `missing` and yields no env', () => {
  const r = resolveLane('openrouter', { PATH: '/usr/bin' })
  assert.equal(r.env, null)
  assert.equal(r.missing, 'OPENROUTER_API_KEY')
  assert.match(describeLane(r), /unavailable: OPENROUTER_API_KEY/)
  assert.doesNotMatch(describeLane(resolveLane('api-key', EVERYTHING)), /sk-native/)
})

test('model override: explicit option beats AGENT_MODEL beats the lane default', () => {
  assert.equal(resolveLane('api-key', EVERYTHING, { model: 'claude-opus-5' }).model, 'claude-opus-5')
  assert.equal(resolveLane('api-key', { ...EVERYTHING, AGENT_MODEL: 'claude-haiku-4-5' }).model, 'claude-haiku-4-5')
})

test('resolveLane never mutates the base env', () => {
  const base = { ...EVERYTHING }
  resolveLane('subscription', base)
  assert.deepEqual(base, EVERYTHING)
})

test('pickLane honours AGENT_LANE, else walks AUTO_ORDER by credential presence', () => {
  assert.equal(pickLane({ ...EVERYTHING, AGENT_LANE: 'moonshot' }), 'moonshot')
  assert.equal(pickLane(EVERYTHING), 'subscription')
  assert.equal(pickLane({ OPENROUTER_API_KEY: 'x', ANTHROPIC_API_KEY: 'y' }), 'openrouter')
  assert.equal(pickLane({ MOONSHOT_API_KEY: 'x' }), 'moonshot')
  assert.equal(pickLane({}), null)
  assert.throws(() => pickLane({ AGENT_LANE: 'bogus' }), /not one of/)
  assert.deepEqual([...AUTO_ORDER].sort(), [...LANES].sort())
})

test('laneAvailable reflects credential presence only', () => {
  assert.equal(laneAvailable('subscription', { CLAUDE_CODE_OAUTH_TOKEN: '' }), false)
  assert.equal(laneAvailable('subscription', { CLAUDE_CODE_OAUTH_TOKEN: 't' }), true)
  assert.equal(laneAvailable('nope', EVERYTHING), false)
})

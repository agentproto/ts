import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULTS, resolveEngine } from './config.mjs'

// ── resolveEngine ─────────────────────────────────────────────────────────

test('resolveEngine accepts "local"', () => {
  assert.equal(resolveEngine({ engine: 'local' }), 'local')
})

test('resolveEngine accepts "cloud"', () => {
  assert.equal(resolveEngine({ engine: 'cloud' }), 'cloud')
})

test('resolveEngine accepts "daemon"', () => {
  assert.equal(resolveEngine({ engine: 'daemon' }), 'daemon')
})

test('resolveEngine rejects a bogus engine, listing all three valid values', () => {
  assert.throws(
    () => resolveEngine({ engine: 'bogus' }),
    /invalid engine "bogus" \(want "local" \| "cloud" \| "daemon"\)/,
  )
})

test('resolveEngine precedence: --flag beats env beats config beats default', () => {
  assert.equal(resolveEngine({ engine: 'cloud' }, { flag: 'daemon' }), 'daemon')
  assert.equal(
    resolveEngine({ engine: 'cloud' }, { flag: undefined, env: { AGENTFLOW_ENGINE: 'daemon' } }),
    'daemon',
  )
  assert.equal(resolveEngine({ engine: 'cloud' }, { env: {} }), 'cloud')
  assert.equal(resolveEngine(undefined, { env: {} }), 'local')
})

// ── DEFAULTS.review daemon settings ──────────────────────────────────────

test('DEFAULTS.review has the daemon engine settings', () => {
  assert.equal(DEFAULTS.review.daemonPort, 18790)
  assert.equal(DEFAULTS.review.daemonTimeoutMinutes, 15)
  assert.equal(DEFAULTS.review.adapter, null)
})

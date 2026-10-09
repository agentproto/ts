import { test } from 'node:test'
import assert from 'node:assert/strict'

import { alreadyPublishedOnly, classifyFailure, runPublish } from './publish-with-retry.mjs'

test('classifyFailure: HTTP 429 is transient', () => {
  assert.equal(classifyFailure('npm WARN publish ... \ngit push failed: HTTP 429 Too Many Requests'), 'transient')
})

test('classifyFailure: fatal error in commit_refs is transient', () => {
  assert.equal(classifyFailure('To github.com/x/y\n ! [remote rejected] v1.0.0 -> v1.0.0 (fatal error in commit_refs)'), 'transient')
})

test('classifyFailure: remote rejected is transient', () => {
  assert.equal(classifyFailure("! [remote rejected] refs/tags/a@1.0.0 (some reason)"), 'transient')
})

test('classifyFailure: unexpected disconnect while reading sideband packet is transient', () => {
  assert.equal(classifyFailure('fatal: unexpected disconnect while reading sideband packet'), 'transient')
})

test('classifyFailure: npm 403 / package-name-unpublishable is non-transient', () => {
  assert.equal(classifyFailure('npm ERR! 403 Forbidden - PUT https://registry.npmjs.org/x - You cannot publish over the previously published version'), 'non-transient')
  assert.equal(classifyFailure('Error: ENOENT no such file or directory'), 'non-transient')
})

test('classifyFailure: empty output is non-transient (never retry blind)', () => {
  assert.equal(classifyFailure(''), 'non-transient')
  assert.equal(classifyFailure(null), 'non-transient')
})

test('alreadyPublishedOnly: every package refused as already published → their names', () => {
  const out = [
    '🦋  error an error occurred while publishing @agentproto/tool: E409 409 Conflict - PUT https://registry.npmjs.org/@agentproto%2ftool - Cannot publish over previously staged version "0.5.0".',
    '🦋  error an error occurred while publishing @agentproto/runtime: E409 409 Conflict - PUT https://registry.npmjs.org/@agentproto%2fruntime - Cannot publish over previously staged version "5.14.0".',
    'npm ERR! 403 Forbidden',
    '🦋  error an error occurred while publishing @agentproto/cli: E403 403 Forbidden - You cannot publish over the previously published versions: 1.0.0.',
  ].join('\n')
  assert.deepEqual(alreadyPublishedOnly(out), ['@agentproto/tool', '@agentproto/runtime', '@agentproto/cli'])
})

test('alreadyPublishedOnly: any other failure → null (stays a real failure)', () => {
  const out = [
    '🦋  error an error occurred while publishing @agentproto/tool: E409 409 Conflict - Cannot publish over previously staged version "0.5.0".',
    '🦋  error an error occurred while publishing @agentproto/cli: E401 Unauthorized',
  ].join('\n')
  assert.equal(alreadyPublishedOnly(out), null)
})

test('alreadyPublishedOnly: no per-package failure at all → null', () => {
  assert.equal(alreadyPublishedOnly('Error: build failed'), null)
  assert.equal(alreadyPublishedOnly(''), null)
  assert.equal(alreadyPublishedOnly(null), null)
})

test('runPublish: an already-published-only failure succeeds without retrying', async () => {
  const logs = []
  const cmd = `node -e "console.error('an error occurred while publishing @agentproto/tool: E409 409 Conflict - Cannot publish over previously staged version \\"0.5.0\\".'); process.exit(1)"`
  const code = await runPublish({ command: cmd, backoffMs: [0, 0], log: (m) => logs.push(m) })
  assert.equal(code, 0)
  assert.equal(logs.filter((l) => l.includes('attempt')).length, 1)
  assert.ok(logs.some((l) => l.includes('treating as success')))
})

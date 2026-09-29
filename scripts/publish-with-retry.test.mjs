import { test } from 'node:test'
import assert from 'node:assert/strict'

import { classifyFailure } from './publish-with-retry.mjs'

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

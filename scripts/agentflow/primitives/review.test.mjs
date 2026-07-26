import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { gatherDiff } from './review.mjs'

// ── fake exec harness ────────────────────────────────────────────────────

function makeFakeExec({ fetchThrows = false } = {}) {
  const calls = []
  const exec = (cmd, root) => {
    calls.push(cmd)
    if (cmd === 'git fetch origin +refs/heads/main:refs/remotes/origin/main --quiet') {
      if (fetchThrows) throw new Error('network unreachable')
      return ''
    }
    if (cmd === 'git diff --name-only origin/main...HEAD') {
      return 'packages/runtime/src/foo.ts\n'
    }
    if (cmd === 'git diff origin/main...HEAD') {
      return '--- a/packages/runtime/src/foo.ts\n+++ b/packages/runtime/src/foo.ts\n'
    }
    throw new Error(`unexpected exec call: ${cmd}`)
  }
  return { exec, calls }
}

// ── tests ────────────────────────────────────────────────────────────────

test('gatherDiff fetches origin/main before computing the diff', () => {
  const { exec, calls } = makeFakeExec()
  gatherDiff('/fake/root', 16_000, exec)
  assert.equal(calls[0], 'git fetch origin +refs/heads/main:refs/remotes/origin/main --quiet')
  assert.ok(
    calls.includes('git diff --name-only origin/main...HEAD'),
    'still computes the name-only diff after fetching',
  )
})

test('a fetch failure is non-fatal — gatherDiff still returns the diff', () => {
  const { exec, calls } = makeFakeExec({ fetchThrows: true })
  const result = gatherDiff('/fake/root', 16_000, exec)
  assert.equal(calls[0], 'git fetch origin +refs/heads/main:refs/remotes/origin/main --quiet')
  assert.equal(result.changedFiles, 'packages/runtime/src/foo.ts')
  assert.equal(result.fileCount, 1)
})

test('no changed files skips the second (full) diff call', () => {
  let sawFullDiffCall = false
  const exec = (cmd) => {
    if (cmd === 'git fetch origin +refs/heads/main:refs/remotes/origin/main --quiet') return ''
    if (cmd === 'git diff --name-only origin/main...HEAD') return ''
    if (cmd === 'git diff origin/main...HEAD') {
      sawFullDiffCall = true
      return 'should not be called'
    }
    throw new Error(`unexpected exec call: ${cmd}`)
  }
  const result = gatherDiff('/fake/root', 16_000, exec)
  assert.equal(sawFullDiffCall, false)
  assert.equal(result.changedFiles, '')
  assert.equal(result.fileCount, 0)
  assert.equal(result.diff, '')
})

test('respects the cap and reports truncation', () => {
  const longDiff = 'x'.repeat(100)
  const exec = (cmd) => {
    if (cmd === 'git fetch origin +refs/heads/main:refs/remotes/origin/main --quiet') return ''
    if (cmd === 'git diff --name-only origin/main...HEAD') return 'a.ts\n'
    if (cmd === 'git diff origin/main...HEAD') return longDiff
    throw new Error(`unexpected exec call: ${cmd}`)
  }
  const result = gatherDiff('/fake/root', 10, exec)
  assert.equal(result.diff.length, 10)
  assert.equal(result.truncated, true)
})

test('default exec parameter is the real execSync-backed implementation (smoke test against this repo)', t => {
  const root = fileURLToPath(new URL('../../..', import.meta.url))
  // Skip in a checkout with no origin/main remote-tracking ref at all
  // (single-branch/shallow clone, offline contributor, non-`main` fork
  // default) -- a real environment-shape difference, not a code failure,
  // and this smoke test's whole point is exercising the REAL default exec
  // (live network fetch included), which needs that ref to exist first.
  try {
    execSync('git rev-parse --verify origin/main', { cwd: root, encoding: 'utf8' })
  } catch {
    t.skip('no origin/main remote-tracking ref in this checkout')
    return
  }
  const result = gatherDiff(root)
  assert.equal(typeof result.fileCount, 'number')
  assert.equal(typeof result.diff, 'string')
})

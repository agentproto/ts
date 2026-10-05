import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { gatherChangedFiles, gatherDiff, reviewViaDaemon } from './review.mjs'

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

// ── gatherChangedFiles ───────────────────────────────────────────────────

test('gatherChangedFiles fetches origin/main then returns names/count with no diff body', () => {
  const { exec, calls } = makeFakeExec()
  const result = gatherChangedFiles('/fake/root', exec)
  assert.equal(calls[0], 'git fetch origin +refs/heads/main:refs/remotes/origin/main --quiet')
  assert.equal(calls.length, 2, 'never calls the full `git diff` (only fetch + --name-only)')
  assert.equal(result.changedFiles, 'packages/runtime/src/foo.ts')
  assert.equal(result.fileCount, 1)
})

// ── reviewViaDaemon (engine "daemon") ────────────────────────────────────

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))

function jsonResult(obj) {
  return { content: [{ text: JSON.stringify(obj) }] }
}

/** A fake MCP client scripted at the tool-call level (same shape a real
 *  daemon connection provides) — reviewViaDaemon is exercised through the
 *  REAL runWorkflowFile/readSessionTail, only the transport is faked. */
function fakeDaemonClient(script) {
  return {
    callTool: async ({ name, arguments: args }) => {
      const handler = script[name]
      if (!handler) throw new Error(`unexpected tool call: ${name}`)
      return handler(args)
    },
  }
}

test('reviewViaDaemon: placement/baseRef/prNumber are set and reviewerSandbox is stripped from reviewConfig', async () => {
  const seenInputs = []
  const client = fakeDaemonClient({
    workflow_run_file: (args) => {
      seenInputs.push(args.input)
      return jsonResult({ runId: 'run-1' })
    },
    workflow_status: () => jsonResult({ status: 'done', result: { sessionIds: ['sess-a'] } }),
    agent_output: () =>
      jsonResult({ lines: ['{"conclusion":"approve","summary":"ok","findings":[]}'] }),
  })
  await reviewViaDaemon({ root: REPO_ROOT, port: 18790, client, timeoutMs: 5000, pollMs: 1 })
  assert.equal(seenInputs.length, 1)
  assert.equal(seenInputs[0].placement, 'local')
  assert.equal(seenInputs[0].baseRef, 'main')
  assert.equal(seenInputs[0].prNumber, 0)
  assert.equal(seenInputs[0].reviewConfig.reviewerSandbox, undefined)
  // .github/agentic-review.json really does set reviewerSandbox — assert the
  // strip actually removed a real key, not just "was already absent."
  assert.equal(seenInputs[0].reviewConfig.reviewerAdapter, 'claude-sdk')
})

test('reviewViaDaemon: an "adapter" override replaces reviewConfig.reviewerAdapter', async () => {
  const seenInputs = []
  const client = fakeDaemonClient({
    workflow_run_file: (args) => {
      seenInputs.push(args.input)
      return jsonResult({ runId: 'run-1' })
    },
    workflow_status: () => jsonResult({ status: 'done', result: { sessionIds: ['sess-a'] } }),
    agent_output: () =>
      jsonResult({ lines: ['{"conclusion":"approve","summary":"ok","findings":[]}'] }),
  })
  await reviewViaDaemon({
    root: REPO_ROOT,
    port: 18790,
    client,
    timeoutMs: 5000,
    pollMs: 1,
    adapter: 'claude-code',
  })
  assert.equal(seenInputs[0].reviewConfig.reviewerAdapter, 'claude-code')
})

test('reviewViaDaemon: maps conclusion "approve" → decision "approve" and uses the LAST session', async () => {
  const client = fakeDaemonClient({
    workflow_run_file: () => jsonResult({ runId: 'run-1' }),
    workflow_status: () =>
      jsonResult({ status: 'done', result: { sessionIds: ['sess-a', 'sess-b'] } }),
    agent_output: ({ sessionId }) => {
      if (sessionId !== 'sess-b') {
        throw new Error(`expected the LAST session (sess-b) to be read, got ${sessionId}`)
      }
      return jsonResult({ lines: ['{"conclusion":"approve","summary":"looks good","findings":[]}'] })
    },
  })
  const verdict = await reviewViaDaemon({ root: REPO_ROOT, port: 18790, client, timeoutMs: 5000, pollMs: 1 })
  assert.deepEqual(verdict, { decision: 'approve', summary: 'looks good', findings: [] })
})

test('reviewViaDaemon: parses the LAST JSON object when earlier output contains braces', async () => {
  const client = fakeDaemonClient({
    workflow_run_file: () => jsonResult({ runId: 'run-1' }),
    workflow_status: () => jsonResult({ status: 'done', result: { sessionIds: ['sess-a'] } }),
    agent_output: () =>
      jsonResult({
        lines: [
          'Looked at config { blocking: true } and the diff.',
          'Tool result: {"ok":true}',
          '{"conclusion":"approve","summary":"clean","findings":[]}',
        ],
      }),
  })
  const verdict = await reviewViaDaemon({ root: REPO_ROOT, port: 18790, client, timeoutMs: 5000, pollMs: 1 })
  assert.deepEqual(verdict, { decision: 'approve', summary: 'clean', findings: [] })
})

test('reviewViaDaemon: maps a non-approve conclusion to "request_changes" and keeps findings', async () => {
  const client = fakeDaemonClient({
    workflow_run_file: () => jsonResult({ runId: 'run-1' }),
    workflow_status: () => jsonResult({ status: 'done', result: { sessionIds: ['sess-a'] } }),
    agent_output: () =>
      jsonResult({
        lines: [
          '{"conclusion":"request_changes","summary":"nope","findings":[{"severity":"high","file":"a.ts","note":"bug"}]}',
        ],
      }),
  })
  const verdict = await reviewViaDaemon({ root: REPO_ROOT, port: 18790, client, timeoutMs: 5000, pollMs: 1 })
  assert.equal(verdict.decision, 'request_changes')
  assert.deepEqual(verdict.findings, [{ severity: 'high', file: 'a.ts', note: 'bug' }])
})

test('reviewViaDaemon: throws a clear error when the run produced no session id', async () => {
  const client = fakeDaemonClient({
    workflow_run_file: () => jsonResult({ runId: 'run-1' }),
    workflow_status: () => jsonResult({ status: 'done', result: { sessionIds: [] } }),
  })
  await assert.rejects(
    () => reviewViaDaemon({ root: REPO_ROOT, port: 18790, client, timeoutMs: 5000, pollMs: 1 }),
    /produced no session id/,
  )
})

test('reviewViaDaemon: throws a clear error when the session output has no parseable verdict', async () => {
  const client = fakeDaemonClient({
    workflow_run_file: () => jsonResult({ runId: 'run-1' }),
    workflow_status: () => jsonResult({ status: 'done', result: { sessionIds: ['sess-a'] } }),
    agent_output: () => jsonResult({ lines: ['no json here at all'] }),
  })
  await assert.rejects(
    () => reviewViaDaemon({ root: REPO_ROOT, port: 18790, client, timeoutMs: 5000, pollMs: 1 }),
    /no parseable verdict/,
  )
})

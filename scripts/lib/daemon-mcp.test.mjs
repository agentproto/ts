import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  connectDaemon,
  parseToolResult,
  readDaemonToken,
  readSessionTail,
  runWorkflowFile,
} from './daemon-mcp.mjs'

function jsonResult(obj) {
  return { content: [{ text: JSON.stringify(obj) }] }
}

/** A fake MCP client: `script` maps tool name -> (args) => result. */
function makeFakeClient(script) {
  const calls = []
  return {
    calls,
    callTool: async ({ name, arguments: args }) => {
      calls.push({ name, args })
      const handler = script[name]
      if (!handler) throw new Error(`unexpected tool call: ${name}`)
      return handler(args, calls)
    },
  }
}

// ── parseToolResult ──────────────────────────────────────────────────────

test('parseToolResult parses the JSON payload out of an MCP tool result', () => {
  assert.deepEqual(parseToolResult(jsonResult({ ok: true })), { ok: true })
})

test('parseToolResult throws on a malformed result shape', () => {
  assert.throws(() => parseToolResult({ content: [{}] }), /unexpected MCP tool result shape/)
})

// ── readDaemonToken ──────────────────────────────────────────────────────

test('readDaemonToken reads the token for a port from ~/.agentproto/daemons/<port>.json', () => {
  const home = mkdtempSync(join(tmpdir(), 'agentflow-daemon-'))
  try {
    const dir = join(home, '.agentproto', 'daemons')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '18790.json'), JSON.stringify({ token: 'tok-abc', port: 18790 }))
    assert.equal(readDaemonToken({ port: 18790, home }), 'tok-abc')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('readDaemonToken throws a clear error when the metadata file is missing', () => {
  const home = mkdtempSync(join(tmpdir(), 'agentflow-daemon-'))
  try {
    assert.throws(
      () => readDaemonToken({ port: 18790, home }),
      /no daemon metadata for port 18790 — is `agentproto serve` running\?/,
    )
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('readDaemonToken throws when the metadata file has no token', () => {
  const home = mkdtempSync(join(tmpdir(), 'agentflow-daemon-'))
  try {
    const dir = join(home, '.agentproto', 'daemons')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '18790.json'), JSON.stringify({ port: 18790 }))
    assert.throws(() => readDaemonToken({ port: 18790, home }), /has no bearer token/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// ── connectDaemon (injectable factory — no real network) ───────────────────

test('connectDaemon uses the injected clientFactory instead of a real connection', async () => {
  const fake = { marker: true }
  const client = await connectDaemon({
    port: 18790,
    token: 'tok',
    clientFactory: async ({ port, token }) => {
      assert.equal(port, 18790)
      assert.equal(token, 'tok')
      return fake
    },
  })
  assert.equal(client, fake)
})

// ── runWorkflowFile ──────────────────────────────────────────────────────

test('runWorkflowFile: happy path polls until done and returns runId/run/sessionIds', async () => {
  let statusCalls = 0
  const client = makeFakeClient({
    workflow_run_file: () => jsonResult({ runId: 'run-1' }),
    workflow_status: () => {
      statusCalls++
      if (statusCalls === 1) return jsonResult({ status: 'running' })
      return jsonResult({
        status: 'done',
        result: { sessionIds: ['sess-a'] },
        stages: [{ steps: [{ sessionId: 'sess-a' }] }],
      })
    },
  })
  const statuses = []
  const result = await runWorkflowFile(client, {
    path: '/x/WORKFLOW.md',
    input: { foo: 'bar' },
    cwd: '/x',
    pollMs: 1,
    onStatus: (run) => statuses.push(run.status),
  })
  assert.equal(result.runId, 'run-1')
  assert.equal(result.run.status, 'done')
  assert.deepEqual(result.sessionIds, ['sess-a'])
  assert.deepEqual(statuses, ['running', 'done'])
  assert.deepEqual(client.calls[0], {
    name: 'workflow_run_file',
    args: { path: '/x/WORKFLOW.md', input: { foo: 'bar' }, cwd: '/x' },
  })
})

test('runWorkflowFile: a stuck run times out, cancels, and throws', async () => {
  const client = makeFakeClient({
    workflow_run_file: () => jsonResult({ runId: 'run-2' }),
    workflow_status: () => jsonResult({ status: 'running' }),
    workflow_cancel: () => jsonResult({ ok: true }),
  })
  await assert.rejects(
    () => runWorkflowFile(client, { path: '/x/WORKFLOW.md', cwd: '/x', pollMs: 1, timeoutMs: 5 }),
    /workflow run run-2 did not reach a terminal status/,
  )
  assert.ok(
    client.calls.some((c) => c.name === 'workflow_cancel' && c.args.runId === 'run-2'),
    'workflow_cancel was called with the timed-out runId',
  )
})

test('runWorkflowFile: a failed run throws with run.error and every step error', async () => {
  const client = makeFakeClient({
    workflow_run_file: () => jsonResult({ runId: 'run-3' }),
    workflow_status: () =>
      jsonResult({
        status: 'failed',
        error: 'adapter auth failed',
        stages: [{ steps: [{ id: 'review', error: 'empty turn' }] }],
      }),
  })
  await assert.rejects(() => runWorkflowFile(client, { path: '/x/WORKFLOW.md', cwd: '/x', pollMs: 1 }), (err) => {
    assert.match(err.message, /run-3/)
    assert.match(err.message, /adapter auth failed/)
    assert.match(err.message, /empty turn/)
    return true
  })
})

test('runWorkflowFile: a cancelled run also throws with the surfaced status', async () => {
  const client = makeFakeClient({
    workflow_run_file: () => jsonResult({ runId: 'run-4' }),
    workflow_status: () => jsonResult({ status: 'cancelled' }),
  })
  await assert.rejects(
    () => runWorkflowFile(client, { path: '/x/WORKFLOW.md', cwd: '/x', pollMs: 1 }),
    /ended with status "cancelled"/,
  )
})

test('runWorkflowFile: workflow_run_file itself failing throws immediately', async () => {
  const client = makeFakeClient({
    workflow_run_file: () => jsonResult({ error: 'workflow not found' }),
  })
  await assert.rejects(
    () => runWorkflowFile(client, { path: '/x/WORKFLOW.md', cwd: '/x' }),
    /workflow_run_file failed: workflow not found/,
  )
})

// ── readSessionTail ──────────────────────────────────────────────────────

test('readSessionTail joins the "lines" array from agent_output into one string', async () => {
  const client = makeFakeClient({
    agent_output: () => jsonResult({ sessionId: 'sess-a', status: 'done', lines: ['a', 'b', 'c'] }),
  })
  assert.equal(await readSessionTail(client, 'sess-a'), 'a\nb\nc')
})

test('readSessionTail falls back to the raw text when it is not the {lines} envelope', async () => {
  const client = makeFakeClient({
    agent_output: () => ({ content: [{ text: 'plain text, not JSON' }] }),
  })
  assert.equal(await readSessionTail(client, 'sess-a'), 'plain text, not JSON')
})

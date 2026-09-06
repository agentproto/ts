#!/usr/bin/env node
/**
 * Shared MCP-over-HTTP contract for talking to a LOCAL `agentproto serve`
 * daemon: read its bearer token, connect an MCP client, drive
 * `workflow_run_file` to a terminal status, and read a session's output tail.
 *
 * This mirrors the contract `.github/actions/agentproto-run/driver.mjs` uses
 * for CI — same tool names (`workflow_run_file`, `workflow_status`,
 * `workflow_cancel`, `agent_output`), same `parseToolResult` shape, same
 * terminal-status + error-surfacing rules. The difference is WHERE the daemon
 * and its token live: CI boots its own daemon and reads the per-boot
 * `.agentproto/runtime.json` it writes; this module talks to a daemon the
 * DEVELOPER already has running, whose token lives at
 * `~/.agentproto/daemons/<port>.json` (there is no `.agentproto/runtime.json`
 * for an ambient `agentproto serve`). Do NOT modify driver.mjs — folding the
 * two onto this module is a follow-up.
 *
 * Dependency-light by design: only `@modelcontextprotocol/sdk` + node
 * builtins, so scripts/ doesn't grow a real dependency tree.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const TERMINAL_STATUSES = new Set(['done', 'failed', 'cancelled'])

/** Parse an MCP `callTool` result's JSON payload (mirrors driver.mjs). */
export function parseToolResult(result) {
  const text = result?.content?.[0]?.text
  if (typeof text !== 'string') {
    throw new Error(`unexpected MCP tool result shape: ${JSON.stringify(result)}`)
  }
  return JSON.parse(text)
}

/**
 * Read the bearer token for a local daemon on `port` from
 * `~/.agentproto/daemons/<port>.json` (the file the daemon itself writes on
 * boot). Throws a clear, actionable error when it's missing — the #1 way a
 * caller ends up here is simply not having `agentproto serve` running.
 */
export function readDaemonToken({ port, home = homedir() } = {}) {
  const metaPath = join(home, '.agentproto', 'daemons', `${port}.json`)
  let raw
  try {
    raw = readFileSync(metaPath, 'utf8')
  } catch {
    throw new Error(`no daemon metadata for port ${port} — is \`agentproto serve\` running?`)
  }
  let meta
  try {
    meta = JSON.parse(raw)
  } catch (err) {
    throw new Error(`malformed daemon metadata at ${metaPath}: ${err.message}`)
  }
  if (!meta.token) throw new Error(`${metaPath} has no bearer token`)
  return meta.token
}

/**
 * Connect an MCP client to a local daemon over StreamableHTTP, at
 * `http://127.0.0.1:<port>/mcp` with the bearer token as `Authorization`.
 * `clientFactory` is injectable for tests — defaults to the real SDK Client +
 * transport (which is what actually performs the network connect, so a
 * refused/unreachable daemon surfaces here).
 */
export async function connectDaemon({ port, token, clientFactory }) {
  if (clientFactory) return clientFactory({ port, token })
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  })
  const client = new Client({ name: 'agentflow-daemon-mcp', version: '0.1.0' }, { capabilities: {} })
  await client.connect(transport)
  return client
}

/** Structured session ids off a terminal run: `run.result.sessionIds` plus
 *  each `stage.steps[].sessionId` (order-preserving, de-duplicated). */
function collectSessionIds(run) {
  const ids = new Set(Array.isArray(run?.result?.sessionIds) ? run.result.sessionIds : [])
  for (const stage of Array.isArray(run?.stages) ? run.stages : []) {
    for (const step of Array.isArray(stage?.steps) ? stage.steps : []) {
      if (typeof step?.sessionId === 'string' && step.sessionId) ids.add(step.sessionId)
    }
  }
  return [...ids]
}

/** Per-step error strings off a terminal run (mirrors driver.mjs's surfacing,
 *  so a failed/cancelled run explains itself instead of just "failed"). */
function collectStepErrors(run) {
  const errors = []
  for (const stage of Array.isArray(run?.stages) ? run.stages : []) {
    for (const step of Array.isArray(stage?.steps) ? stage.steps : []) {
      if (typeof step?.error === 'string' && step.error) {
        errors.push(`step '${step.label ?? step.id ?? '?'}' error: ${step.error}`)
      }
    }
  }
  return errors
}

/**
 * Run a WORKFLOW.md file to a terminal status and return
 * `{ runId, run, sessionIds }`.
 *
 * Polls `workflow_status` every `pollMs` (default 3000) until the run reaches
 * `done` | `failed` | `cancelled`, or `timeoutMs` (default 15 minutes)
 * elapses — on timeout it cancels the run via `workflow_cancel` and throws.
 * On `failed` / `cancelled` it throws with `run.error` plus every step error
 * attached (same surfacing driver.mjs does for CI logs), so a caller's error
 * message is never a bare "failed".
 *
 * `onStatus(run, runId)` is called after every poll (including the first),
 * so a caller can print progress while it waits.
 */
export async function runWorkflowFile(
  client,
  { path, input = {}, cwd, timeoutMs = 15 * 60_000, pollMs = 3000, onStatus } = {},
) {
  const startResult = await client.callTool({
    name: 'workflow_run_file',
    arguments: { path, input, cwd },
  })
  const started = parseToolResult(startResult)
  if (started.error) throw new Error(`workflow_run_file failed: ${started.error}`)
  const { runId } = started

  const pollDeadline = Date.now() + timeoutMs
  let run
  for (;;) {
    if (Date.now() > pollDeadline) {
      try {
        await client.callTool({ name: 'workflow_cancel', arguments: { runId } })
      } catch {
        // best-effort cancel — the timeout error below is what matters
      }
      throw new Error(`workflow run ${runId} did not reach a terminal status within ${timeoutMs}ms`)
    }
    const statusResult = await client.callTool({ name: 'workflow_status', arguments: { runId } })
    run = parseToolResult(statusResult)
    // A missing `status` means the tool call itself errored (e.g. "run not
    // found") — `run.error` is ALSO a legitimate field on a normal run (the
    // failure reason once status reaches "failed"), so only a missing status
    // is fatal here.
    if (!run.status) throw new Error(`workflow_status failed: ${run.error ?? 'unknown error'}`)
    onStatus?.(run, runId)
    if (TERMINAL_STATUSES.has(run.status)) break
    await sleep(pollMs)
  }

  if (run.status !== 'done') {
    const parts = [`workflow run ${runId} ended with status "${run.status}"`]
    if (run.error) parts.push(`error: ${run.error}`)
    parts.push(...collectStepErrors(run))
    throw new Error(parts.join(' — '))
  }

  return { runId, run, sessionIds: collectSessionIds(run) }
}

/** Read a session's clean output tail (tool/thought framing stripped) as one
 *  newline-joined string. Returns '' if the tool result has no lines. */
export async function readSessionTail(client, sessionId, { lastN = 400 } = {}) {
  const result = await client.callTool({
    name: 'agent_output',
    arguments: { sessionId, lastN, clean: true },
  })
  const text = result?.content?.[0]?.text
  if (typeof text !== 'string') return ''
  try {
    const parsed = JSON.parse(text)
    return Array.isArray(parsed?.lines) ? parsed.lines.join('\n') : text
  } catch {
    return text
  }
}

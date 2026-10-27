#!/usr/bin/env node

/** Run one Claude Code Cloud turn through the local agentproto relay in CI. */

import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'

const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf8',
}).trim()
const args = process.argv.slice(2)

function value(flag) {
  const index = args.indexOf(flag)
  if (index < 0 || index === args.length - 1) throw new Error(`${flag} requires a value`)
  return args[index + 1]
}

const promptFile = resolve(ROOT, value('--prompt-file'))
const outputFile = resolve(ROOT, value('--output'))
const label = args.includes('--label') ? value('--label') : 'ci-claude-cloud'
const port = Number(process.env.AGENTPROTO_CLOUD_CI_PORT || 18791)
const cli = resolve(ROOT, 'packages/cli/dist/cli.mjs')
const runtimeFile = resolve(ROOT, '.agentproto/runtime.json')
const logFile = resolve(process.env.RUNNER_TEMP || '/tmp', `agentproto-cloud-${process.pid}.log`)

if (!existsSync(promptFile)) throw new Error(`prompt file not found: ${promptFile}`)
for (const name of ['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CLOUD_OAUTH_TOKEN']) {
  if (!process.env[name]) throw new Error(`${name} is required`)
}

// `claude --cloud` resolves the org UUID from CLAUDE_CODE_ORGANIZATION_UUID,
// then ~/.claude.json oauthAccount.organizationUuid, then the profile API. A
// `setup-token` credential has no profile scope, so on a clean runner all
// three come up empty ("Unable to get organization UUID"). Pin it explicitly.
const orgUuid = process.env.CLAUDE_CLOUD_ORG_UUID?.trim()
if (!orgUuid) {
  throw new Error('CLAUDE_CLOUD_ORG_UUID is required: `claude --cloud` cannot resolve the organization from a setup-token login')
}
process.env.CLAUDE_CODE_ORGANIZATION_UUID = orgUuid

const delay = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms))

function unwrapFence(text) {
  const trimmed = text.trim()
  const match = /^```(?:diff|patch|markdown|md)?\s*\n([\s\S]*?)\n```$/.exec(trimmed)
  return (match?.[1] ?? trimmed).trim() + '\n'
}

async function waitForDaemon() {
  for (let attempt = 0; attempt < 90; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`)
      if (response.ok && existsSync(runtimeFile)) return
    } catch {}
    await delay(1_000)
  }
  throw new Error(`agentproto daemon did not become healthy; see ${logFile}`)
}

// A clean runner has no ~/.claude.json, so `claude --cloud` (driven under a
// PTY by the relay) opens the first-run onboarding — the theme picker — and
// waits there until the relay's 120s start timeout, which surfaces as an
// empty turn. Seed onboarding + trust for this checkout so the start goes
// straight to the session, whatever job calls this script.
function seedClaudeConfig() {
  const configFile = process.env.CLAUDE_CONFIG_DIR
    ? resolve(process.env.CLAUDE_CONFIG_DIR, '.claude.json')
    : resolve(homedir(), '.claude.json')
  let config = {}
  try {
    config = JSON.parse(readFileSync(configFile, 'utf8'))
  } catch {}
  config.hasCompletedOnboarding = true
  config.theme ||= 'dark'
  config.oauthAccount = { ...config.oauthAccount, organizationUuid: orgUuid }
  config.projects ||= {}
  for (const dir of new Set([ROOT, realpathSync(ROOT)])) {
    config.projects[dir] = { ...config.projects[dir], hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true }
  }
  mkdirSync(dirname(configFile), { recursive: true })
  writeFileSync(configFile, JSON.stringify(config, null, 2))
}

function parseJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** Last host-recorded stderr error from the session transcript, if any. */
function lastTranscriptStderr(sessionId) {
  const transcriptFile = resolve(
    process.env.RUNNER_TEMP || '/tmp',
    `claude-cloud-failed-${sessionId}.json`,
  )
  try {
    execFileSync(
      process.execPath,
      [cli, 'sessions', 'export', sessionId, '--source', 'daemon', '--json', '-o', transcriptFile],
      { cwd: ROOT, env: process.env, stdio: 'ignore' },
    )
    const transcript = JSON.parse(readFileSync(transcriptFile, 'utf8'))
    const messages = Array.isArray(transcript.messages) ? transcript.messages : []
    const last = [...messages].reverse().find(
      message =>
        message?.role === 'system' &&
        typeof message.text === 'string' &&
        /stderr:|\[turn error\]|\[error\]/.test(message.text),
    )
    return last?.text?.trim().slice(-4_000)
  } catch {
    return undefined
  }
}

/**
 * Turn a wait failure into the detail the old script discarded: the matched
 * turn-end reason/error (exit 4), or the last turn the descriptor recorded
 * when the pre-flight saw an idle session (exit 5), plus the session's last
 * recorded stderr. A bare execFileSync error only says "Command failed".
 */
async function describeWaitFailure(sessionId, runtime, error) {
  const parts = []
  const waitOutput = typeof error?.stdout === 'string' ? error.stdout : ''
  const wait = parseJson(waitOutput)
  if (wait && typeof wait === 'object') {
    if (wait.idle === true) parts.push('session was idle when wait started')
    if (typeof wait.reason === 'string') parts.push(`turn-end reason: ${wait.reason}`)
    if (typeof wait.error === 'string' && wait.error.trim()) {
      parts.push(`turn error: ${wait.error.trim()}`)
    }
    if (wait.empty === true) parts.push('turn was empty (no assistant text or tool call)')
    if (typeof wait.turnsCompleted === 'number') {
      parts.push(`turns completed: ${wait.turnsCompleted}`)
    }
  } else {
    const stderr = typeof error?.stderr === 'string' ? error.stderr.trim() : ''
    if (waitOutput.trim()) parts.push(`wait stdout: ${waitOutput.trim()}`)
    if (stderr) parts.push(`wait stderr: ${stderr}`)
  }

  try {
    const response = await fetch(
      `http://127.0.0.1:${port}/sessions/${encodeURIComponent(sessionId)}`,
      { headers: { authorization: `Bearer ${runtime.token}` } },
    )
    if (response.ok) {
      const desc = await response.json()
      if (typeof desc.lastTurnReason === 'string') {
        parts.push(`last turn-end reason: ${desc.lastTurnReason}`)
      }
      if (typeof desc.lastTurnErrorMessage === 'string' && desc.lastTurnErrorMessage.trim()) {
        parts.push(`last turn error: ${desc.lastTurnErrorMessage.trim()}`)
      }
      if (desc.lastTurnEmpty === true) parts.push('last turn was empty')
      if (desc.endedReason && desc.endedReason !== desc.lastTurnReason) {
        parts.push(`ended reason: ${desc.endedReason}`)
      }
      if (typeof desc.lastError === 'string' && desc.lastError.trim()) {
        parts.push(`last error: ${desc.lastError.trim()}`)
      }
    }
  } catch {}

  const stderr = lastTranscriptStderr(sessionId)
  if (stderr) parts.push(`last session stderr:\n${stderr}`)

  return parts.length > 0
    ? parts.join('\n')
    : `no wait detail (${error instanceof Error ? error.message : String(error)})`
}

async function main() {
  seedClaudeConfig()
  const logFd = openSync(logFile, 'a')
  const daemon = spawn(process.execPath, [cli, 'serve', '--workspace', ROOT, '--port', String(port)], {
    cwd: ROOT,
    env: process.env,
    stdio: ['ignore', logFd, logFd],
  })

  try {
    await waitForDaemon()
    const runtime = JSON.parse(readFileSync(runtimeFile, 'utf8'))
    const response = await fetch(`http://127.0.0.1:${port}/sessions/agent`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${runtime.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        cloud: 'anthropic',
        cwd: ROOT,
        prompt: readFileSync(promptFile, 'utf8'),
        label,
        keepAlive: false,
      }),
    })
    if (!response.ok) throw new Error(`cloud session start failed (${response.status}): ${await response.text()}`)
    const descriptor = await response.json()
    if (descriptor.adapterSlug !== 'claude-code-cloud') {
      throw new Error(`expected claude-code-cloud, got ${descriptor.adapterSlug || '(missing)'}`)
    }

    // Replay from the event-ring origin. The spawn response can return, and a
    // fast first turn can end, before this wait process reads the descriptor;
    // without a cursor the CLI reports that session as idle (exit 5) and the
    // turn-end (including a vendor error) is lost. `--since 0` lets the
    // daemon's replay/state check return the turn-end that already fired.
    try {
      const waitOutput = execFileSync(
        process.execPath,
        [cli, 'sessions', 'wait', descriptor.id, '--until', 'turn-end', '--since', '0', '--timeout', '40m', '--json'],
        {
          cwd: ROOT,
          env: process.env,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      )
      console.log(waitOutput.trim())
    } catch (error) {
      const detail = await describeWaitFailure(descriptor.id, runtime, error)
      throw new Error(`session wait failed for ${descriptor.id}:\n${detail}`)
    }
    const transcriptFile = resolve(process.env.RUNNER_TEMP || '/tmp', `claude-cloud-${descriptor.id}.json`)
    execFileSync(process.execPath, [cli, 'sessions', 'export', descriptor.id, '--source', 'daemon', '--json', '-o', transcriptFile], {
      cwd: ROOT,
      env: process.env,
      stdio: ['ignore', 'inherit', 'inherit'],
    })
    const transcript = JSON.parse(readFileSync(transcriptFile, 'utf8'))
    const answer = [...(transcript.messages || [])].reverse().find((message) => message.role === 'assistant' && typeof message.text === 'string' && message.text.trim())?.text
    if (!answer) throw new Error('Claude Cloud produced no final assistant text')
    writeFileSync(outputFile, unwrapFence(answer), 'utf8')
    if (process.env.GITHUB_OUTPUT) {
      const provenance = JSON.stringify([
        {
          sessionId: descriptor.id,
          label,
          adapter: 'claude-code-cloud',
          source: 'adapter',
        },
      ])
      appendFileSync(process.env.GITHUB_OUTPUT, `session_id=${descriptor.id}\nprovenance=${provenance}\n`)
    }
    console.log(`Claude Cloud output written to ${outputFile}`)
  } finally {
    daemon.kill('SIGTERM')
    await Promise.race([once(daemon, 'exit'), delay(5_000)])
    if (daemon.exitCode === null) daemon.kill('SIGKILL')
    closeSync(logFd)
  }
}

main().catch((error) => {
  console.error(`claude-cloud-ci: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})

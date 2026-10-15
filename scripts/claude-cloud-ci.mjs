#!/usr/bin/env node

/** Run one Claude Code Cloud turn through the local agentproto relay in CI. */

import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

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

async function main() {
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

    execFileSync(process.execPath, [cli, 'sessions', 'wait', descriptor.id, '--until', 'turn-end', '--timeout', '40m', '--json'], {
      cwd: ROOT,
      env: process.env,
      stdio: ['ignore', 'inherit', 'inherit'],
    })
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

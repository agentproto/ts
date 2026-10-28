import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildLocalEnv, runLocal } from './llm.mjs'

function fakeClaude(body) {
  const dir = mkdtempSync(join(tmpdir(), 'fake-claude-'))
  const bin = join(dir, 'claude')
  writeFileSync(bin, `#!/bin/sh\n${body}\n`)
  chmodSync(bin, 0o755)
  return bin
}

const call = (claudeBin, env) => runLocal({ system: 's', user: 'u', claudeBin, env })

test('runLocal error includes stdout when claude fails with an empty stderr', () => {
  const bin = fakeClaude('echo "Not logged in · Please run /login"; exit 1')
  assert.throws(() => call(bin, {}), /exited 1: .*Not logged in · Please run \/login/)
})

test('runLocal error includes both stderr and stdout', () => {
  const bin = fakeClaude('echo "warn line" >&2; echo "real failure"; exit 3')
  assert.throws(() => call(bin, {}), /exited 3: stderr: warn line \| stdout: real failure/)
})

test('runLocal error bounds very long output', () => {
  const bin = fakeClaude('head -c 50000 /dev/zero | tr "\\0" x; exit 1')
  assert.throws(
    () => call(bin, {}),
    (e) => e.message.length < 2300 && e.message.endsWith('…'),
  )
})

test('runLocal reports (no output) when claude fails silently', () => {
  const bin = fakeClaude('exit 2')
  assert.throws(() => call(bin, {}), /exited 2: \(no output\)/)
})

test('runLocal returns trimmed stdout on success', () => {
  const bin = fakeClaude('echo "  ok  "')
  assert.equal(call(bin, {}), 'ok')
})

test('buildLocalEnv drops the isolated CLAUDE_CONFIG_DIR inside a Claude Code session', () => {
  const out = buildLocalEnv({ CLAUDECODE: '1', CLAUDE_CONFIG_DIR: '/iso', PATH: '/bin' })
  assert.equal('CLAUDE_CONFIG_DIR' in out, false)
  assert.equal(out.PATH, '/bin')
})

test('buildLocalEnv keeps CLAUDE_CONFIG_DIR from a plain terminal', () => {
  const out = buildLocalEnv({ CLAUDE_CONFIG_DIR: '/mine' })
  assert.equal(out.CLAUDE_CONFIG_DIR, '/mine')
})

test('buildLocalEnv honors AGENTFLOW_CLAUDE_CONFIG_DIR over the session dir', () => {
  const out = buildLocalEnv({
    CLAUDECODE: '1',
    CLAUDE_CONFIG_DIR: '/iso',
    AGENTFLOW_CLAUDE_CONFIG_DIR: '/chosen',
  })
  assert.equal(out.CLAUDE_CONFIG_DIR, '/chosen')
})

test('runLocal passes the sanitized env to the child', () => {
  const bin = fakeClaude('echo "cfg=${CLAUDE_CONFIG_DIR:-unset}"')
  assert.equal(call(bin, { CLAUDECODE: '1', CLAUDE_CONFIG_DIR: '/iso' }), 'cfg=unset')
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseVerbs, missingVerbPages, findStaleVersions } from './docs.mjs'

// The dispatcher shape docs.mjs parses out of packages/cli/src/cli.ts.
const CLI_SRC = `
const USAGE = "…"
const VERBS = new Set([
  "auth",
  "run-swarm",
  "chat-tui",
  "mcp-bridge",
  // a comment line
  "cron",
])
async function main() {}
`

test('parseVerbs pulls every slug from the VERBS set, hyphens included', () => {
  assert.deepEqual(parseVerbs(CLI_SRC), ['auth', 'run-swarm', 'chat-tui', 'mcp-bridge', 'cron'])
})

test('parseVerbs throws when the VERBS set is absent (fail loud, not silent-empty)', () => {
  assert.throws(() => parseVerbs('const OTHER = new Set(["x"])'), /VERBS set/)
})

test('parseVerbs ignores commented-out entries (no phantom verbs)', () => {
  const src = 'const VERBS = new Set([\n  "run",\n  // "disabled",\n  "chat", // inline note\n])'
  assert.deepEqual(parseVerbs(src), ['run', 'chat'])
})

test('missingVerbPages flags verbs with no page and honours the alias map', () => {
  const verbs = ['auth', 'cron', 'chat', 'chat-tui']
  // chat-tui aliases to chat, which has a page → not missing. cron has none.
  const pages = ['auth', 'chat']
  assert.deepEqual(missingVerbPages(verbs, pages), ['cron'])
})

test('missingVerbPages returns empty when every verb is covered', () => {
  assert.deepEqual(missingVerbPages(['a', 'b'], new Set(['a', 'b'])), [])
})

test('findStaleVersions flags a drifted --version example inside a code fence', () => {
  const text = '```bash\nagentproto --version\n# → agentproto 0.1.0-alpha\n```'
  assert.deepEqual(findStaleVersions(text, '0.6.0'), [{ found: '0.1.0-alpha', expected: '0.6.0' }])
})

test('findStaleVersions ignores prose (unfenced) — historical refs are not rewritten', () => {
  const text = [
    'agentproto 0.5.0 introduced the swarm kernel.', // historical prose, unfenced
    'Node ≥ 20.9.0', // not an agentproto token
    'the `@xterm/addon-fit` is ^0.11.0', // dependency, no agentproto prefix
    'pre-1.0 (`0.6.0`)', // status note, no `agentproto <ver>` token
  ].join('\n')
  assert.deepEqual(findStaleVersions(text, '0.6.0'), [])
})

test('findStaleVersions ignores the current version even inside a fence', () => {
  assert.deepEqual(findStaleVersions('```\nagentproto 0.6.0\n```', '0.6.0'), [])
})

test('findStaleVersions catches multiple drifted tokens across fences, not prose', () => {
  const text = '```\nagentproto 0.5.0\n```\nprose: agentproto 0.3.0 was the first.\n```\nagentproto 0.4.0\n```'
  assert.deepEqual(findStaleVersions(text, '0.6.0'), [
    { found: '0.5.0', expected: '0.6.0' },
    { found: '0.4.0', expected: '0.6.0' },
  ])
})

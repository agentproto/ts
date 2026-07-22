import { test } from 'node:test'
import assert from 'node:assert/strict'
import { packagesForFiles } from './list-changed-packages.mjs'

const index = [
  { dir: 'packages/runtime', name: '@agentproto/runtime', private: false },
  { dir: 'packages/vscode', name: 'agentproto-vscode', private: false },
  { dir: 'packages/tooling', name: '@agentproto/tooling', private: true },
]

test('maps changed files to their real publishable package names, deduped + sorted', () => {
  assert.deepEqual(
    packagesForFiles(
      ['packages/runtime/src/index.ts', 'packages/runtime/src/x.ts', 'packages/vscode/src/ext.ts'],
      index,
    ),
    ['@agentproto/runtime', 'agentproto-vscode'],
  )
})

test('emits the vscode name UNSCOPED — the exact name the reviewer keeps inventing scoped', () => {
  assert.deepEqual(packagesForFiles(['packages/vscode/package.json'], index), ['agentproto-vscode'])
})

test('includes a private package by its REAL name (the bug is the name, not publishability)', () => {
  // `agentproto-vscode` is itself private; a changeset may still reference it,
  // and must use the real name — the whole point of this script.
  assert.deepEqual(packagesForFiles(['packages/tooling/eslint.js'], index), ['@agentproto/tooling'])
})

test('a file outside any workspace package maps to nothing', () => {
  assert.deepEqual(packagesForFiles(['scripts/foo.mjs', 'README.md'], index), [])
})

test('longest-prefix wins so a nested package beats its parent', () => {
  const nested = [
    { dir: 'packages/governance', name: '@agentproto/governance', private: false },
    { dir: 'packages/governance/core', name: '@agentproto/governance-core', private: false },
  ]
  assert.deepEqual(
    packagesForFiles(['packages/governance/core/src/x.ts'], nested),
    ['@agentproto/governance-core'],
  )
})

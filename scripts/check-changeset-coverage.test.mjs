import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  changedPublishablePackages,
  isPublishAffecting,
  publishablePackageMap,
  publishedFileEntries,
} from './check-changeset-coverage.mjs'

const pkgMap = new Map([
  ['packages/auth/', '@agentproto/auth'],
  ['packages/cli/', '@agentproto/cli'],
  ['adapters/hermes/', '@agentproto/adapter-hermes'],
  ['packages/catalog-sync/', '@agentproto/catalog-sync'],
])

// Stand-in for each package.json `files` array, so these tests don't read disk.
const FILES = {
  'packages/auth/': ['dist', 'skill', 'README.md', 'LICENSE'],
  'packages/cli/': ['dist', 'README.md'],
  'adapters/hermes/': ['dist', 'HERMES.md', 'SECRETS.md', 'README.md'],
  'packages/catalog-sync/': ['dist', 'snapshots', 'README.md', 'LICENSE'],
}
const opts = { filesOf: (prefix) => FILES[prefix] }

test('src change counts as publish-affecting', () => {
  const touched = changedPublishablePackages(['packages/auth/src/eligibility.ts'], pkgMap, opts)
  assert.deepEqual([...touched], ['@agentproto/auth'])
})

test('package.json change counts', () => {
  const touched = changedPublishablePackages(['packages/cli/package.json'], pkgMap, opts)
  assert.deepEqual([...touched], ['@agentproto/cli'])
})

test('README / test / config changes do NOT count', () => {
  const touched = changedPublishablePackages(
    [
      'packages/auth/README.md',
      'packages/auth/src/__tests__/x.test.ts',
      'packages/cli/tsconfig.json',
      'packages/cli/CHANGELOG.md',
      'packages/cli/dist/index.mjs',
    ],
    pkgMap,
    opts,
  )
  assert.equal(touched.size, 0)
})

test('the #1770 scenario: a test-only edit under src/ demands no bump', () => {
  const touched = changedPublishablePackages(
    ['packages/catalog-sync/src/__tests__/llm-context-windows.test.ts'],
    pkgMap,
    opts,
  )
  assert.equal(touched.size, 0)
})

test('every test shape under src/ is excluded; real src next to it still counts', () => {
  for (const rest of [
    'src/__tests__/helpers.ts',
    'src/deep/__tests__/fixture.json',
    'src/foo.test.ts',
    'src/foo.spec.mts',
    'src/bar/baz.test.tsx',
    'src/__snapshots__/foo.test.ts.snap',
  ]) {
    assert.equal(isPublishAffecting(rest, ['dist']), false, rest)
  }
  for (const rest of ['src/index.ts', 'src/testing.ts', 'src/latest.ts', 'src/spec/schema.ts']) {
    assert.equal(isPublishAffecting(rest, ['dist']), true, rest)
  }
})

test('published non-src `files` entries count: catalog-sync snapshots, adapter docs, auth skill', () => {
  const touched = changedPublishablePackages(
    [
      'packages/catalog-sync/snapshots/openrouter.json',
      'adapters/hermes/HERMES.md',
      'packages/auth/skill/SKILL.md',
    ],
    pkgMap,
    opts,
  )
  assert.deepEqual([...touched].sort(), [
    '@agentproto/adapter-hermes',
    '@agentproto/auth',
    '@agentproto/catalog-sync',
  ])
})

test('a path merely sharing a `files` entry prefix does not count', () => {
  assert.equal(isPublishAffecting('snapshots-old/x.json', ['snapshots']), false)
  assert.equal(isPublishAffecting('HERMES.md.bak', ['HERMES.md']), false)
  assert.equal(isPublishAffecting('snapshots', ['snapshots']), true)
})

test('publishedFileEntries drops dist/README/LICENSE and negations, trims globs', () => {
  assert.deepEqual(
    publishedFileEntries([
      'dist',
      'dist/**/*.mjs',
      'README.md',
      'LICENSE',
      'license.txt',
      '!snapshots/tmp',
      './schemas/',
      'skills/**/*.md',
      '**/*.json',
      '.claude-plugin',
    ]),
    ['schemas', 'skills', '.claude-plugin'],
  )
  assert.deepEqual(publishedFileEntries(undefined), [])
})

test('reads `files` from disk by default: real catalog-sync snapshots count', () => {
  const map = publishablePackageMap()
  const touched = changedPublishablePackages(
    ['packages/catalog-sync/snapshots/x.json', 'packages/catalog-sync/src/__tests__/y.test.ts'],
    map,
  )
  assert.deepEqual([...touched], ['@agentproto/catalog-sync'])
})

test('the #470 scenario: both auth and cli src changed → both flagged', () => {
  const touched = changedPublishablePackages(
    ['packages/auth/src/eligibility.ts', 'packages/cli/src/cli.ts'],
    pkgMap,
    opts,
  )
  assert.deepEqual([...touched].sort(), ['@agentproto/auth', '@agentproto/cli'])
})

test('files outside any package map to nothing', () => {
  const touched = changedPublishablePackages(['scripts/foo.mjs', '.github/workflows/ci.yml'], pkgMap, opts)
  assert.equal(touched.size, 0)
})

test('publishablePackageMap excludes private packages and finds real ones', () => {
  const map = publishablePackageMap()
  // Every value is a public @agentproto package; auth is present, the private
  // vscode extension is not.
  const names = [...map.values()]
  assert.ok(names.includes('@agentproto/auth'), 'auth should be discovered')
  assert.ok(!names.includes('agentproto-vscode'), 'private vscode must be excluded')
  assert.ok(names.every((n) => n.startsWith('@agentproto/')))
})

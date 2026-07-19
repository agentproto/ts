import { test } from 'node:test'
import assert from 'node:assert/strict'

import { changedPublishablePackages, publishablePackageMap } from './check-changeset-coverage.mjs'

const pkgMap = new Map([
  ['packages/auth/', '@agentproto/auth'],
  ['packages/cli/', '@agentproto/cli'],
  ['adapters/hermes/', '@agentproto/adapter-hermes'],
])

test('src change counts as publish-affecting', () => {
  const touched = changedPublishablePackages(['packages/auth/src/eligibility.ts'], pkgMap)
  assert.deepEqual([...touched], ['@agentproto/auth'])
})

test('package.json change counts', () => {
  const touched = changedPublishablePackages(['packages/cli/package.json'], pkgMap)
  assert.deepEqual([...touched], ['@agentproto/cli'])
})

test('README / test / config changes do NOT count', () => {
  const touched = changedPublishablePackages(
    [
      'packages/auth/README.md',
      'packages/auth/src/__tests__/x.test.ts', // still under src/ → counts (build input)
      'packages/cli/tsconfig.json',
      'packages/cli/CHANGELOG.md',
    ],
    pkgMap,
  )
  // README/tsconfig/CHANGELOG excluded; the src/__tests__ file is under src/ so it counts.
  assert.deepEqual([...touched], ['@agentproto/auth'])
})

test('the #470 scenario: both auth and cli src changed → both flagged', () => {
  const touched = changedPublishablePackages(
    ['packages/auth/src/eligibility.ts', 'packages/cli/src/cli.ts'],
    pkgMap,
  )
  assert.deepEqual([...touched].sort(), ['@agentproto/auth', '@agentproto/cli'])
})

test('files outside any package map to nothing', () => {
  const touched = changedPublishablePackages(['scripts/foo.mjs', '.github/workflows/ci.yml'], pkgMap)
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

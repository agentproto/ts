import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BUILD_EXTRAS, DEFAULT_WEIGHT, WEIGHTS, buildExtras, partition } from './ci-test-shards.mjs'

const names = [...Object.keys(WEIGHTS), ...Array.from({ length: 40 }, (_, i) => `@agentproto/pkg-${String(i).padStart(2, '0')}`)]

test('every package lands in exactly one shard', () => {
  const shards = partition(names, 4)
  const flat = shards.flat()
  assert.equal(flat.length, names.length)
  assert.deepEqual([...flat].sort(), [...names].sort())
})

test('a heavy package never shares a shard with another heavy one when shards allow', () => {
  const heavy = ['@agentproto/runtime', 'agentproto-vscode', '@agentproto/worktree', '@agentproto/cli']
  const shards = partition(names, 4)
  for (const h of heavy) {
    const holders = shards.filter((s) => s.includes(h))
    assert.equal(holders.length, 1)
    assert.equal(holders[0].filter((n) => heavy.includes(n)).length, 1, `${h} shares a shard with another heavy package`)
  }
})

test('shard loads stay within the heaviest single package of each other', () => {
  const weightOf = (n) => WEIGHTS[n] ?? DEFAULT_WEIGHT
  const loads = partition(names, 4).map((s) => s.reduce((sum, n) => sum + weightOf(n), 0))
  const heaviest = Math.max(...names.map(weightOf))
  assert.ok(Math.max(...loads) - Math.min(...loads) <= heaviest, `loads ${loads.join('/')} spread past ${heaviest}`)
})

test('unknown packages fall back to DEFAULT_WEIGHT instead of failing', () => {
  const shards = partition(['brand-new-pkg', '@agentproto/runtime'], 2)
  assert.equal(shards.flat().length, 2)
  assert.notDeepEqual(shards[0], shards[1])
})

test('is deterministic and ignores input order and duplicates', () => {
  const a = partition(names, 3)
  const b = partition([...names].reverse().concat(names.slice(0, 5)), 3)
  assert.deepEqual(a, b)
})

test('more shards than packages leaves the extras empty, never drops a package', () => {
  const shards = partition(['a', 'b'], 4)
  assert.equal(shards.length, 4)
  assert.equal(shards.flat().length, 2)
})

test('rejects a non-positive shard count', () => {
  assert.throws(() => partition(names, 0), /positive integer/)
})

test('the shard running the cli also builds the adapter its jcode smoke test loads', () => {
  const shards = partition(names, 4)
  const holder = shards.find((s) => s.includes('@agentproto/cli'))
  assert.deepEqual(buildExtras(holder), ['@agentproto/adapter-jcode'])
  for (const s of shards.filter((s) => s !== holder)) assert.deepEqual(buildExtras(s), [])
})

test('buildExtras dedupes targets shared by several tested packages', () => {
  assert.deepEqual(buildExtras(['a', 'b', 'c'], { a: ['x', 'y'], b: ['y'] }), ['x', 'y'])
})

test('BUILD_EXTRAS only names packages that exist in the workspace', async () => {
  const { execFileSync } = await import('node:child_process')
  const root = new URL('..', import.meta.url).pathname
  const all = new Set(JSON.parse(execFileSync('pnpm', ['ls', '-r', '--depth', '-1', '--json'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 })).map((p) => p.name))
  for (const [tested, extras] of Object.entries(BUILD_EXTRAS)) {
    assert.ok(all.has(tested), `${tested} is not a workspace package`)
    for (const e of extras) assert.ok(all.has(e), `${e} (extra of ${tested}) is not a workspace package`)
  }
})

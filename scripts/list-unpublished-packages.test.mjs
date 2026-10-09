import { test } from 'node:test'
import assert from 'node:assert/strict'

import { isPublished, listUnpublished, listUnpublishedSettled, workspaceGlobs } from './list-unpublished-packages.mjs'

const respond = (status) => async () => ({ status })

test('workspaceGlobs: extracts dir/* entries', () => {
  const yaml = 'packages:\n  - "packages/*"\n  - "packages/driver/*"\n  - adapters/*\n  - "!x"\n'
  assert.deepEqual(workspaceGlobs(yaml), ['packages', 'packages/driver', 'adapters'])
})

test('isPublished: 200 → true, 404 → false, anything else → null', async () => {
  const pkg = { name: '@agentproto/cli', version: '1.0.0' }
  assert.equal(await isPublished(pkg, respond(200)), true)
  assert.equal(await isPublished(pkg, respond(404)), false)
  assert.equal(await isPublished(pkg, respond(429)), null)
  assert.equal(await isPublished(pkg, respond(503)), null)
  assert.equal(await isPublished(pkg, async () => { throw new Error('offline') }), null)
})

test('isPublished: scoped name is URL-encoded', async () => {
  let url
  await isPublished({ name: '@agentproto/cli', version: '1.2.3' }, async (u) => { url = u; return { status: 200 } })
  assert.match(url, /\/@agentproto%2fcli\/1\.2\.3$/)
})

test('listUnpublished: keeps 404 and unknown (fail-open), drops published', async () => {
  const pkgs = [
    { name: 'a', version: '1.0.0' },
    { name: 'b', version: '1.0.0' },
    { name: 'c', version: '1.0.0' },
  ]
  const status = { a: 200, b: 404, c: 500 }
  const fetchImpl = async (u) => ({ status: status[u.split('/').at(-2)] })
  assert.deepEqual((await listUnpublished(pkgs, fetchImpl)).map((p) => p.name), ['b', 'c'])
})

test('listUnpublished: everything published → empty', async () => {
  assert.deepEqual(await listUnpublished([{ name: 'a', version: '1' }], respond(200)), [])
})

test('listUnpublishedSettled: a version that appears after a re-check is not pending (registry lag)', async () => {
  const pkgs = [{ name: 'a', version: '1.0.0' }, { name: 'b', version: '1.0.0' }]
  let reads = 0
  // `a` reads 404 on the first pass only; `b` is really missing.
  const fetchImpl = async (u) => {
    const name = u.split('/').at(-2)
    if (name === 'a') return { status: reads++ === 0 ? 404 : 200 }
    return { status: 404 }
  }
  const sleeps = []
  const pending = await listUnpublishedSettled(pkgs, { fetchImpl, rounds: 3, waitMs: 5, sleep: async (ms) => { sleeps.push(ms) }, log: () => {} })
  assert.deepEqual(pending.map((p) => p.name), ['b'])
  assert.deepEqual(sleeps, [5, 5, 5])
})

test('listUnpublishedSettled: nothing pending → no wait', async () => {
  const sleeps = []
  const pending = await listUnpublishedSettled([{ name: 'a', version: '1' }], { fetchImpl: respond(200), sleep: async (ms) => { sleeps.push(ms) }, log: () => {} })
  assert.deepEqual(pending, [])
  assert.deepEqual(sleeps, [])
})

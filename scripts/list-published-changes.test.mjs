import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isPublishedPath, filterPublishedChanges } from './list-published-changes.mjs'

const index = [
  {
    dir: 'packages/core',
    name: '@agentproto/core',
    private: false,
    files: ['dist', 'README.md', 'LICENSE'],
    hasSrcDir: true,
  },
  {
    dir: 'packages/llm-endpoint',
    name: '@agentproto/llm-endpoint',
    private: false,
    files: ['dist', 'README.md', 'LICENSE'],
    hasSrcDir: true,
  },
  {
    dir: 'packages/tooling',
    name: '@agentproto/tooling',
    private: true,
    files: ['dist', 'README.md'],
    hasSrcDir: true,
  },
]

test('docs-only change in a public package does not reach the published surface', () => {
  assert.deepEqual(filterPublishedChanges(['packages/llm-endpoint/docs/router-ux-design.md'], index), [])
})

test('src/ change in a public package reaches the published surface (compiles into the shipped dist)', () => {
  assert.deepEqual(filterPublishedChanges(['packages/core/src/index.ts'], index), ['packages/core/src/index.ts'])
})

test('a change under a files[]-listed dir (dist) in a public package reaches the published surface', () => {
  assert.deepEqual(
    filterPublishedChanges(['packages/core/dist/index.mjs'], index),
    ['packages/core/dist/index.mjs'],
  )
})

test('a README change in a public package reaches the published surface (it is the npm page)', () => {
  assert.deepEqual(filterPublishedChanges(['packages/core/README.md'], index), ['packages/core/README.md'])
})

test('any change under a private package never reaches the published surface, regardless of files[] or src/', () => {
  assert.deepEqual(
    filterPublishedChanges(
      ['packages/tooling/dist/index.mjs', 'packages/tooling/README.md', 'packages/tooling/src/x.ts'],
      index,
    ),
    [],
  )
})

test('isPublishedPath: package.json is always published', () => {
  assert.equal(isPublishedPath('package.json', ['dist']), true)
})

test('isPublishedPath: implicit README/LICENSE/CHANGELOG match at package root regardless of files[]', () => {
  assert.equal(isPublishedPath('README.md', ['dist']), true)
  assert.equal(isPublishedPath('LICENSE', ['dist']), true)
  assert.equal(isPublishedPath('CHANGELOG.md', ['dist']), true)
})

test('isPublishedPath: implicit root-file matching does not reach into subdirectories', () => {
  assert.equal(isPublishedPath('docs/README.md', ['dist']), false)
})

test('isPublishedPath: src/** only counts as published when the package has a src/ dir', () => {
  assert.equal(isPublishedPath('src/index.ts', ['dist'], { hasSrcDir: true }), true)
  assert.equal(isPublishedPath('src/index.ts', ['dist'], { hasSrcDir: false }), false)
})

test('isPublishedPath: exact-segment matching does not let a listed dir match a sibling prefix', () => {
  // "skill" must not match "skills/foo.json" — that's a different directory.
  assert.equal(isPublishedPath('skills/foo.json', ['skill']), false)
  assert.equal(isPublishedPath('skill/foo.json', ['skill']), true)
})

test('isPublishedPath: no files[] declared is treated as "everything published" (in doubt, require changeset)', () => {
  assert.equal(isPublishedPath('anything/at/all.ts', null), true)
})

test('filterPublishedChanges: a changed path owned by no indexed package counts as published (in doubt)', () => {
  assert.deepEqual(filterPublishedChanges(['packages/unknown/src/x.ts'], index), ['packages/unknown/src/x.ts'])
})

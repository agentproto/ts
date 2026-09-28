import { test } from 'node:test'
import assert from 'node:assert/strict'
import { declaredPackages, nearestWorkspaceName, fixChangeset, mergeFrontmatterBlocks } from './check-changesets.mjs'

const KNOWN = new Set(['agentproto-vscode', '@agentproto/cli', '@agentproto/runtime'])

test('declaredPackages reads names + bumps from frontmatter, ignores the body', () => {
  const md = '---\n"@agentproto/cli": patch\n"agentproto-vscode": minor\n---\n\nBody: agentproto-runtime unaffected.'
  assert.deepEqual(declaredPackages(md), ['@agentproto/cli', 'agentproto-vscode'])
})

test('nearestWorkspaceName collapses the scope↔dash near-miss', () => {
  assert.equal(nearestWorkspaceName('@agentproto/vscode', KNOWN), 'agentproto-vscode')
})

test('nearestWorkspaceName returns null for an already-valid name (nothing to fix)', () => {
  assert.equal(nearestWorkspaceName('agentproto-vscode', KNOWN), null)
})

test('nearestWorkspaceName returns null when nothing plausibly matches', () => {
  assert.equal(nearestWorkspaceName('@agentproto/totally-made-up', KNOWN), null)
})

test('nearestWorkspaceName refuses to guess when two packages normalise the same', () => {
  const ambiguous = new Set(['agentproto-vscode', '@agentproto/vscode-x', 'agentprotovscode'])
  assert.equal(nearestWorkspaceName('@agentproto/vscode', ambiguous), null)
})

test('fixChangeset rewrites the mis-scoped name in frontmatter, preserving bump + body', () => {
  const md = '---\n"@agentproto/vscode": patch\n---\n\nFix the thing (@agentproto/vscode in prose stays).'
  const { text, fixed, unresolved } = fixChangeset(md, KNOWN)
  assert.deepEqual(fixed, [{ from: '@agentproto/vscode', to: 'agentproto-vscode' }])
  assert.deepEqual(unresolved, [])
  assert.match(text, /^---\n"agentproto-vscode": patch\n---/)
  // Prose mention outside the frontmatter is left untouched.
  assert.match(text, /@agentproto\/vscode in prose stays/)
})

test('fixChangeset leaves a valid changeset byte-identical', () => {
  const md = '---\n"@agentproto/cli": minor\n---\n\nA real bump.'
  const { text, fixed } = fixChangeset(md, KNOWN)
  assert.equal(text, md)
  assert.deepEqual(fixed, [])
})

test('fixChangeset reports an unresolvable name instead of mangling it', () => {
  const md = '---\n"@agentproto/ghost": patch\n---\n'
  const { text, fixed, unresolved } = fixChangeset(md, KNOWN)
  assert.equal(text, md)
  assert.deepEqual(fixed, [])
  assert.deepEqual(unresolved, ['@agentproto/ghost'])
})

test('mergeFrontmatterBlocks collapses one-block-per-package into a single frontmatter (pr-1505)', () => {
  const md =
    '---\n"@agentproto/runtime": minor\n---\n\nAdd capabilities_inventory.\n\n' +
    '---\n"@agentproto/apps": minor\n---\n\nAdd the Capabilities view.\n'
  const { text, merged } = mergeFrontmatterBlocks(md)
  assert.equal(merged, true)
  assert.deepEqual(declaredPackages(text), ['@agentproto/runtime', '@agentproto/apps'])
  assert.match(text, /Add capabilities_inventory\.\n\nAdd the Capabilities view\.\n$/)
})

test('mergeFrontmatterBlocks keeps the highest bump for a package declared twice', () => {
  const md = '---\n"@agentproto/cli": patch\n---\n\nA.\n\n---\n"@agentproto/cli": minor\n---\n\nB.\n'
  assert.equal(mergeFrontmatterBlocks(md).text, '---\n"@agentproto/cli": minor\n---\n\nA.\n\nB.\n')
})

test('mergeFrontmatterBlocks leaves a single-block changeset and body --- rules alone', () => {
  const md = '---\n"@agentproto/cli": patch\n---\n\nIntro.\n\n---\n\nMore prose after a rule.\n'
  assert.deepEqual(mergeFrontmatterBlocks(md), { text: md, merged: false })
})

/**
 * Regression tests for the docs-check.mjs path-confinement guard (rescued
 * from the dead docs-check-on-release branch, commit 84f4c06 — its PR (#271)
 * merged without it).
 *
 * Two real bugs the guard fixes, both found by running docs-check.mjs live
 * against a real repo under `bypassPermissions`:
 *   - `allowedTools` only gates auto-approval, not tool availability — fixed
 *     by using `tools` instead (see docs-check.mjs's query() options).
 *   - Read/Grep/Glob accept absolute paths and are not sandboxed to `cwd` by
 *     the SDK — a run read a file well outside its repo. `canUseTool` doesn't
 *     fire for non-"dangerous" ops like Read; `PreToolUse` does fire
 *     unconditionally, so `confineToRepoRoot` denies any resolved path that
 *     escapes the repo root there.
 *
 * Run: node --test scripts/path-confine.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { resolvePathArg, makeConfineToRepoRoot } from './lib/path-confine.mjs'

const ROOT = '/repo'

test('resolvePathArg: Read/Grep/Glob use `path`, falling back to `file_path`', () => {
  assert.equal(resolvePathArg(ROOT, 'Glob', { path: 'docs' }), '/repo/docs')
  assert.equal(resolvePathArg(ROOT, 'Grep', { path: 'docs', pattern: 'x' }), '/repo/docs')
  // Read has no `path` field, only `file_path` — must fall back to it.
  assert.equal(resolvePathArg(ROOT, 'Read', { file_path: 'README.md' }), '/repo/README.md')
})

test('resolvePathArg: Edit always uses `file_path`', () => {
  assert.equal(resolvePathArg(ROOT, 'Edit', { file_path: 'docs/x.md' }), '/repo/docs/x.md')
})

test('resolvePathArg: missing path input defaults to root (e.g. Glob with no `path`)', () => {
  assert.equal(resolvePathArg(ROOT, 'Glob', { pattern: '**/*.md' }), ROOT)
})

test('confineToRepoRoot: allows a path inside the repo', async () => {
  const guard = makeConfineToRepoRoot(ROOT)
  const decision = await guard({ tool_name: 'Read', tool_input: { file_path: '/repo/docs/agents.md' } })
  assert.equal(decision.hookSpecificOutput.permissionDecision, 'allow')
})

test('confineToRepoRoot: allows the root itself', async () => {
  const guard = makeConfineToRepoRoot(ROOT)
  const decision = await guard({ tool_name: 'Glob', tool_input: { pattern: '**/*.md' } })
  assert.equal(decision.hookSpecificOutput.permissionDecision, 'allow')
})

test('confineToRepoRoot: denies an absolute path outside the repo (the live-verified escape)', async () => {
  const guard = makeConfineToRepoRoot(ROOT)
  const decision = await guard({
    tool_name: 'Read',
    tool_input: { file_path: '/Users/someone/.claude/projects/some-project/memory/MEMORY.md' },
  })
  assert.equal(decision.hookSpecificOutput.permissionDecision, 'deny')
  assert.match(decision.hookSpecificOutput.permissionDecisionReason, /escapes the repo root/)
})

test('confineToRepoRoot: denies a sibling directory that merely shares the repo root as a string prefix', async () => {
  // /repo-evil starts with the string "/repo" but is not inside it — a naive
  // `.startsWith(ROOT)` (without the trailing '/') would wrongly allow this.
  const guard = makeConfineToRepoRoot(ROOT)
  const decision = await guard({ tool_name: 'Read', tool_input: { file_path: '/repo-evil/secret.txt' } })
  assert.equal(decision.hookSpecificOutput.permissionDecision, 'deny')
})

test('confineToRepoRoot: denies path traversal out of the repo via ..', async () => {
  const guard = makeConfineToRepoRoot(ROOT)
  const decision = await guard({ tool_name: 'Read', tool_input: { file_path: '../outside/secret.txt' } })
  assert.equal(decision.hookSpecificOutput.permissionDecision, 'deny')
})

test('confineToRepoRoot: denies an Edit outside the repo even when Read is scoped elsewhere', async () => {
  const guard = makeConfineToRepoRoot(ROOT)
  const decision = await guard({ tool_name: 'Edit', tool_input: { file_path: '/etc/hosts' } })
  assert.equal(decision.hookSpecificOutput.permissionDecision, 'deny')
})

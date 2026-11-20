import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const SCRIPT = resolve(import.meta.dirname, 'reparent-onto-remote.sh')
const git = (cwd, ...a) =>
  execFileSync('git', a, { cwd, encoding: 'utf8' }).trim()
const ident = ['-c', 'user.name=t', '-c', 'user.email=t@t']

// A remote whose branch was pushed by an earlier run, and a fresh clone of
// main (what a re-run checks out) holding a new commit with the new bump.
function scenario() {
  const root = mkdtempSync(join(tmpdir(), 'reparent-'))
  const remote = join(root, 'remote.git')
  const seed = join(root, 'seed')
  const fresh = join(root, 'fresh')
  git(root, 'init', '-q', '--bare', '-b', 'main', remote)
  git(root, 'clone', '-q', remote, seed)
  writeFileSync(join(seed, 'a.txt'), 'main\n')
  git(seed, 'add', '.')
  git(seed, ...ident, 'commit', '-qm', 'main')
  git(seed, 'push', '-q', 'origin', 'HEAD:main')
  // Re-run: fresh checkout of main taken BEFORE the earlier run's branch
  // exists locally, so the old tip is not an object here (the real failure:
  // "Not a valid commit name").
  git(root, 'clone', '-q', remote, fresh)
  // Earlier run: branch pushed with its own commit.
  git(seed, 'switch', '-qc', 'bump')
  writeFileSync(join(seed, 'dep.txt'), 'old bump\n')
  git(seed, 'add', '.')
  git(seed, ...ident, 'commit', '-qm', 'old bump')
  git(seed, 'push', '-q', 'origin', 'bump')
  const oldTip = git(seed, 'rev-parse', 'HEAD')
  git(fresh, 'switch', '-qc', 'bump')
  writeFileSync(join(fresh, 'dep.txt'), 'new bump\n')
  git(fresh, 'add', '.')
  git(fresh, ...ident, 'commit', '-qm', 'new bump')
  return { root, remote, fresh, oldTip, seed }
}

const isAncestor = (cwd, a, b) =>
  spawnSync('git', ['merge-base', '--is-ancestor', a, b], { cwd }).status === 0

test('control: without re-parenting, the new commit does not descend from the remote tip', () => {
  const { fresh, oldTip } = scenario()
  // The exact git-cas failure: the old tip is not even an object here.
  assert.notEqual(spawnSync('git', ['cat-file', '-e', oldTip], { cwd: fresh }).status, 0)
  assert.equal(isAncestor(fresh, oldTip, 'HEAD'), false)
})

test('re-parented: the new tree is kept and the commit descends from the remote tip', () => {
  const { fresh, oldTip } = scenario()
  const treeBefore = git(fresh, 'rev-parse', 'HEAD^{tree}')
  const r = spawnSync('bash', [SCRIPT, 'origin', 'bump', oldTip, 'chore: bump'], {
    cwd: fresh,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(git(fresh, 'rev-parse', 'HEAD^{tree}'), treeBefore)
  assert.equal(isAncestor(fresh, oldTip, 'HEAD'), true)
  assert.equal(git(fresh, 'rev-parse', 'HEAD^'), oldTip)
  // And it fast-forwards the remote.
  git(fresh, 'push', '-q', 'origin', 'HEAD:refs/heads/bump')
})

test('head_moved: exits 3 when the branch is not where the job started', () => {
  const { fresh, oldTip, seed } = scenario()
  writeFileSync(join(seed, 'late.txt'), 'x\n')
  git(seed, 'add', '.')
  git(seed, ...ident, 'commit', '-qm', 'someone pushed')
  git(seed, 'push', '-q', 'origin', 'bump')
  const r = spawnSync('bash', [SCRIPT, 'origin', 'bump', oldTip, 'chore: bump'], {
    cwd: fresh,
    encoding: 'utf8',
  })
  assert.equal(r.status, 3)
  assert.match(r.stderr, /head_moved/)
})

test('identical tree: no empty commit, HEAD becomes the remote tip', () => {
  const { fresh, oldTip, seed } = scenario()
  // Make this run's tree equal to the remote branch's tree.
  const tree = git(seed, 'rev-parse', `${oldTip}^{tree}`)
  git(fresh, 'fetch', '-q', 'origin', 'bump')
  git(fresh, ...ident, 'commit-tree', tree, '-m', 'same') // sanity: object reachable
  git(fresh, 'checkout', '-q', oldTip, '--', '.')
  git(fresh, ...ident, 'commit', '-qm', 'same tree', '--allow-empty')
  const r = spawnSync('bash', [SCRIPT, 'origin', 'bump', oldTip, 'chore: bump'], { cwd: fresh, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(git(fresh, 'rev-parse', 'HEAD'), oldTip)
})

test('branch deleted since job start: exits 3 (head_moved)', () => {
  const { fresh, oldTip, seed } = scenario()
  git(seed, 'push', '-q', 'origin', '--delete', 'bump')
  const r = spawnSync('bash', [SCRIPT, 'origin', 'bump', oldTip, 'chore: bump'], { cwd: fresh, encoding: 'utf8' })
  assert.equal(r.status, 3)
  assert.match(r.stderr, /no longer exists/)
})

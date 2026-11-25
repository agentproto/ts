import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { pendingChangesets } from './release-needed.mjs'

function repo(files) {
  const root = mkdtempSync(join(tmpdir(), 'release-needed-'))
  mkdirSync(join(root, '.changeset'))
  for (const f of files) writeFileSync(join(root, '.changeset', f), '---\n---\n')
  return root
}

test('a repo with only the README and the config has nothing pending', () => {
  const root = repo(['README.md', 'config.json'])
  try {
    assert.deepEqual(pendingChangesets(root), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('every other markdown file in .changeset is a pending changeset', () => {
  const root = repo(['README.md', 'config.json', 'brave-lions-jump.md', 'a-small-fix.md'])
  try {
    assert.deepEqual(pendingChangesets(root), ['a-small-fix.md', 'brave-lions-jump.md'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('no .changeset directory means nothing pending, not a crash', () => {
  const root = mkdtempSync(join(tmpdir(), 'release-needed-'))
  try {
    assert.deepEqual(pendingChangesets(root), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the Release workflow runs its job only behind the gate, and skips only on an explicit no', async () => {
  const { readFileSync } = await import('node:fs')
  const wf = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')
  assert.match(wf, /\n  release:\n    name: Version or publish\n    needs: gate\n    if: \$\{\{ needs\.gate\.outputs\.run == 'true' \}\}\n/)
  assert.match(wf, /\[ "\$EVENT" != "workflow_dispatch" \] && \[ "\$CHANGESETS" = "false" \] && \[ "\$UNPUBLISHED" = "false" \]/)
})

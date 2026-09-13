#!/usr/bin/env node
/**
 * Write the changeset the catalog-sync PR needs, deterministically.
 *
 * `changeset-check` (.github/workflows/ci.yml) fails any PR that touches a
 * publishable package without a changeset, and the sync PR always touches
 * `@agentproto/model-catalog`. Nothing was writing one — the agentic reviewer
 * that normally auto-generates changesets doesn't run on that bot-authored PR
 * — so it could never go green on its own.
 *
 * Unlike `scripts/auto-changeset.mjs` this needs no LLM: a catalog sync is
 * always the same shape (regenerated provider data → patch bump), and the set
 * of packages is read straight from the working-tree diff.
 *
 * Uses `changedPublishablePackages`, the SAME helper changeset-check uses, so
 * the set written here is exactly the set it will demand — including its rule
 * that only `src/**` and `package.json` are publish-affecting (the refreshed
 * snapshots under `packages/catalog-sync/` are not).
 *
 * Usage: node scripts/write-catalog-changeset.mjs [--out <path>]
 * Exit 0 always on success, including "nothing to write".
 */

import { execSync } from 'node:child_process'
import { writeFileSync, unlinkSync, readdirSync } from 'node:fs'
import {
  publishablePackageMap,
  changedPublishablePackages,
} from './check-changeset-coverage.mjs'

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '')

/**
 * The filename must diff as ADDED against origin/main: changeset-check
 * ("Changeset present?" in ci.yml) uses `git diff --diff-filter=A`. Always
 * sha-suffix rather than trying a plain name first (broke PR #1040, then
 * PR #1063 the same way one level deeper: a plain-name run swept and
 * rewrote a PREVIOUS sha-suffixed changeset still unconsumed on main —
 * same content, different name, and git's own rename detection turned that
 * delete+add into a Renamed entry, which --diff-filter=A also doesn't
 * count). A fresh sha every run means there is never a name collision to
 * detect in the first place.
 */
function defaultOutPath() {
  const sha = execSync('git rev-parse --short HEAD', {
    cwd: ROOT,
    encoding: 'utf8',
  }).trim()
  return `${ROOT}/.changeset/catalog-sync-auto-${sha}.md`
}

/** True if `relPath` (e.g. ".changeset/foo.md") exists, unchanged, on origin/main. */
function isOnOriginMain(relPath) {
  try {
    execSync(`git cat-file -e origin/main:${relPath}`, { cwd: ROOT, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const outFlag = process.argv.indexOf('--out')
const OUT = outFlag !== -1 ? process.argv[outFlag + 1] : defaultOutPath()

const changedFiles = execSync('git diff --name-only', {
  cwd: ROOT,
  encoding: 'utf8',
})
  .split('\n')
  .filter(Boolean)

const packages = [
  ...changedPublishablePackages(changedFiles, publishablePackageMap(ROOT)),
].sort()

if (packages.length === 0) {
  console.log('No publishable package drifted — no changeset needed.')
  process.exit(0)
}

// Sweep older bot-owned changesets (catalog-sync-auto*.md) from the working
// tree so suffixed names don't accumulate across sync runs on the SAME
// branch. Human-authored changesets are never touched — the prefix is the
// ownership contract. Critically, this only removes files this branch
// itself added in an earlier commit — a changeset that's still on
// origin/main (unconsumed from a previous, already-merged sync PR) is left
// alone. Deleting + recreating one of those with identical content is
// exactly what produced the Renamed-not-Added diff that broke #1040/#1063.
for (const name of readdirSync(`${ROOT}/.changeset`)) {
  if (!name.startsWith('catalog-sync-auto') || !name.endsWith('.md')) continue
  const relPath = `.changeset/${name}`
  const stale = `${ROOT}/${relPath}`
  if (stale === OUT) continue
  if (isOnOriginMain(relPath)) continue
  unlinkSync(stale)
}

const frontmatter = packages.map((name) => `"${name}": patch`).join('\n')
writeFileSync(
  OUT,
  `---\n${frontmatter}\n---\n\nSync generated catalog data from the pinned provider sources.\n`
)

console.log(`Changeset written to ${OUT} for: ${packages.join(', ')}`)

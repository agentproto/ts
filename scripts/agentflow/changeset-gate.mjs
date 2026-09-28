#!/usr/bin/env node
/**
 * Local changeset gate — the deterministic pre-push check (no LLM).
 *
 *   node scripts/agentflow/changeset-gate.mjs [baseRef]   (default origin/main)
 *
 * Changesets are authored locally (`pnpm changeset:ai`) and the CI reviewer
 * only writes one as a backup. This gate makes the local path the real one:
 * when a publishable package's `src/**` or `package.json` changed on this
 * branch, the branch itself must ADD a changeset that names every such
 * package, in a single frontmatter block. Otherwise the push is refused with
 * the command that fixes it.
 *
 * It reads the COMMITTED state (`git show HEAD:<file>`), because that is what
 * gets pushed — an uncommitted fix on disk doesn't count. It counts only the
 * changesets this branch adds: a merged-but-unreleased changeset from main
 * naming the same package must not make this branch look covered.
 *
 * Skips `main` and `changeset-release/*` (the release PR deletes changesets
 * and bumps package.json by design). Escape hatch: AGENTFLOW_SKIP_CHANGESET=1.
 *
 * Exit: 0 = covered or nothing to check · 1 = missing/malformed changeset
 */
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { publishablePackageMap, changedPublishablePackages } from '../check-changeset-coverage.mjs'
import { declaredPackages, mergeFrontmatterBlocks } from '../check-changesets.mjs'

const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '')

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim()

/**
 * Pure verdict over what the branch changed and the changesets it added.
 * `added` is `[{ file, text }]`. Returns `{ ok, touched, problems }`.
 */
export function changesetVerdict(touched, added) {
  const problems = []
  if (touched.size === 0) return { ok: true, touched, problems }
  if (added.length === 0) {
    problems.push(`no changeset on this branch for: ${[...touched].join(', ')}`)
    return { ok: false, touched, problems }
  }
  const declared = new Set()
  for (const { file, text } of added) {
    if (mergeFrontmatterBlocks(text).merged) {
      problems.push(`${file}: several frontmatter blocks — only the first is read; merge them into one`)
    }
    for (const n of declaredPackages(text)) declared.add(n)
  }
  const missing = [...touched].filter((n) => !declared.has(n))
  if (missing.length) problems.push(`not in any changeset on this branch: ${missing.join(', ')}`)
  return { ok: problems.length === 0, touched, problems }
}

function main(argv) {
  if (process.env.AGENTFLOW_SKIP_CHANGESET === '1') return 0
  const baseRef = argv[0] || 'origin/main'
  let branch = ''
  try {
    branch = git('rev-parse', '--abbrev-ref', 'HEAD')
  } catch {
    /* detached or odd state — still check */
  }
  if (branch === 'main' || branch.startsWith('changeset-release/')) return 0

  let changed, addedFiles
  try {
    changed = git('diff', '--name-only', `${baseRef}...HEAD`).split('\n').filter(Boolean)
    addedFiles = git('diff', '--name-only', '--diff-filter=A', `${baseRef}...HEAD`, '--', '.changeset')
      .split('\n')
      .filter((f) => f.endsWith('.md') && !f.endsWith('/README.md'))
  } catch (err) {
    // No base ref locally (fresh clone, offline) — don't wedge the push; CI still checks.
    console.warn(`[agentflow] changeset gate skipped: git diff vs ${baseRef} failed (${err.message.split('\n')[0]})`)
    return 0
  }

  const touched = changedPublishablePackages(changed, publishablePackageMap(ROOT))
  const added = addedFiles.map((file) => ({ file, text: git('show', `HEAD:${file}`) }))
  const { ok, problems } = changesetVerdict(touched, added)
  if (ok) {
    if (touched.size) console.log(`[agentflow] ✓ changeset covers ${[...touched].join(', ')}`)
    return 0
  }
  console.error(
    `\n[agentflow] ✗ push blocked — changeset:\n` +
      problems.map((p) => `  - ${p}`).join('\n') +
      `\n\n  Fix: pnpm changeset:ai   (writes .changeset/<slug>.md for every changed package)\n` +
      `       review it, git add .changeset && git commit, then push again.\n` +
      `  Stacked blocks: node scripts/check-changesets.mjs --fix, then commit.\n` +
      `  Bypass (CI reviewer writes one as a backup): AGENTFLOW_SKIP_CHANGESET=1 git push\n`,
  )
  return 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)))
}

#!/usr/bin/env node
/**
 * Per-package changeset COVERAGE: every publishable package whose source
 * changed in this PR must appear in some changeset. Complements
 * `check-changesets.mjs` (which validates that changeset names are REAL) and
 * the `changeset-check` job's presence gate (which requires *a* changeset).
 *
 * The gap this closes is exactly how `@agentproto/auth` got stranded: #470
 * changed BOTH `auth` (new `eligibleProfiles` export) and `cli` (consumes it),
 * but the auto-generated changeset only listed `cli`. `changeset-check` was
 * satisfied ("a changeset exists"), `check-changesets` was satisfied ("cli is a
 * real package") — nothing verified that `auth`, also changed, was bumped. So
 * `auth` was never republished, and every `npm i -g @agentproto/cli@latest`
 * crashed on the missing export.
 *
 * Rule: a package under `packages/**` or `adapters/**` that is publishable
 * (`@agentproto/*`, not `private`) and whose `src/**` (or `package.json`)
 * changed vs the base ref must be named in at least one `.changeset/*.md`.
 * Docs-only / test-only / config-only changes to a package do NOT require a
 * bump (mirrors the presence gate's intent), so only `src/**` + `package.json`
 * count as publish-affecting.
 *
 * Deliberately lenient on timing: with ZERO changesets present it exits 0 and
 * defers to the presence gate (the reviewer writes changesets after the first
 * push). It only enforces coverage once at least one changeset exists.
 *
 * Usage: node scripts/check-changeset-coverage.mjs [baseRef]   (default origin/main)
 * Exit:  0 = every changed publishable package is covered (or nothing to check)
 *        1 = a changed publishable package is missing from every changeset
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'

import { declaredPackages } from './check-changesets.mjs'

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..')

/** Map each publishable package dir-prefix → its npm name. */
export function publishablePackageMap(root = ROOT) {
  const map = new Map() // "packages/foo/" → "@agentproto/foo"
  for (const group of ['packages', 'adapters']) {
    const base = resolve(root, group)
    if (!existsSync(base)) continue
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue
      const pj = resolve(base, entry.name, 'package.json')
      if (!existsSync(pj)) continue
      try {
        const { name, private: priv } = JSON.parse(readFileSync(pj, 'utf8'))
        if (name && name.startsWith('@agentproto/') && priv !== true) {
          map.set(`${group}/${entry.name}/`, name)
        }
      } catch {
        /* unparseable package.json is not this script's problem */
      }
    }
  }
  return map
}

/** Publishable packages whose publish-affecting files changed vs base. */
export function changedPublishablePackages(changedFiles, pkgMap) {
  const touched = new Set()
  for (const file of changedFiles) {
    // Only src/** and package.json affect the published artifact; a README,
    // test, or tsconfig change does not need a version bump.
    for (const [prefix, name] of pkgMap) {
      if (!file.startsWith(prefix)) continue
      const rest = file.slice(prefix.length)
      if (rest.startsWith('src/') || rest === 'package.json') touched.add(name)
    }
  }
  return touched
}

/** Every package named across all changesets on disk. */
function allDeclaredPackages(root = ROOT) {
  const dir = resolve(root, '.changeset')
  if (!existsSync(dir)) return { names: new Set(), fileCount: 0 }
  const files = readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'README.md')
  const names = new Set()
  for (const f of files) {
    for (const n of declaredPackages(readFileSync(resolve(dir, f), 'utf8'))) names.add(n)
  }
  return { names, fileCount: files.length }
}

function main(argv) {
  const baseRef = argv[0] || 'origin/main'
  let changedFiles = []
  try {
    changedFiles = execFileSync('git', ['diff', '--name-only', `${baseRef}...HEAD`], {
      cwd: ROOT,
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean)
  } catch (err) {
    console.error(`check-changeset-coverage: git diff against ${baseRef} failed: ${err.message}`)
    return 1
  }

  const pkgMap = publishablePackageMap()
  const touched = changedPublishablePackages(changedFiles, pkgMap)
  if (touched.size === 0) {
    console.log('No publishable package src changed — coverage not required.')
    return 0
  }

  const { names: declared, fileCount } = allDeclaredPackages()
  if (fileCount === 0) {
    console.log(
      `Publishable packages changed (${[...touched].join(', ')}) but no changeset exists yet — ` +
        'deferring to the presence gate (pr-review writes one after the first push).',
    )
    return 0
  }

  const uncovered = [...touched].filter((n) => !declared.has(n))
  if (uncovered.length === 0) {
    console.log(`✓ All changed publishable packages are in a changeset: ${[...touched].join(', ')}`)
    return 0
  }

  console.error(
    `✗ Changed publishable package(s) missing from every changeset: ${uncovered.join(', ')}\n` +
      `  Changed: ${[...touched].join(', ')}\n` +
      `  Declared in changesets: ${[...declared].join(', ') || '(none)'}\n` +
      '  This is the publish-skew that stranded @agentproto/auth: a changed package that\n' +
      "  isn't bumped is never republished, so dependents ship against a stale npm version.\n" +
      "  Add each package above to a changeset (or run 'pnpm changeset').",
  )
  return 1
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)))
}

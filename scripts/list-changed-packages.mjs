#!/usr/bin/env node
/**
 * Print the EXACT `package.json` names of the publishable workspace packages a
 * diff touches — the authoritative source for a changeset's frontmatter keys.
 *
 * Why this exists: the agentic reviewer (`.github/agentproto-workflows/pr-
 * review/entry.mjs`) is told to run THIS script to find changed packages, then
 * write a changeset for them. Without it, the reviewer falls back to guessing
 * names from the diff — and because the monorepo is almost entirely
 * `@agentproto/*`, it reliably mis-guesses the ONE unscoped package,
 * `agentproto-vscode`, as `@agentproto/vscode`. That name is not a real
 * package, so `changeset version` on main fails and takes down every Release
 * until healed (the pr-338 and pr-600 incidents). Printing the real names lets
 * the reviewer copy them verbatim instead of inferring.
 *
 * Every changed workspace package is listed, private ones included: the bug
 * this fixes is the NAME (`@agentproto/vscode` — which resolves to no package —
 * vs the real `agentproto-vscode`), not publishability. A changeset may
 * legitimately reference a private package (`changeset version` bumps it, it
 * just isn't published), and it MUST use the real name to pass the validator.
 * The `private` flag is still reported so a caller can tell "no changeset
 * required" (the gate only requires one for a publishable change) from the
 * name itself.
 *
 * Usage: node scripts/list-changed-packages.mjs [<base-ref>]
 *   base-ref defaults to origin/main (the PR diff base).
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve, dirname, relative } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..')

/**
 * `[{ dir, name, private }]` for every workspace package under `packages/` and
 * `adapters/`, where `dir` is relative to the repo root. Mirrors
 * `check-changesets.mjs`'s `workspacePackages`, but keeps the directory so a
 * changed file can be mapped back to its owning package.
 */
export function buildPackageIndex(root = ROOT) {
  const out = []
  const globs = ['packages', 'adapters']
  const walk = (dir, depth = 0) => {
    if (depth > 3 || !existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const full = resolve(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full, depth + 1)
      } else if (entry.name === 'package.json') {
        try {
          const pkg = JSON.parse(readFileSync(full, 'utf8'))
          if (pkg.name) {
            out.push({ dir: relative(root, dir), name: pkg.name, private: pkg.private === true })
          }
        } catch {
          /* unparseable package.json is not this script's problem */
        }
      }
    }
  }
  for (const g of globs) walk(resolve(root, g))
  return out
}

/**
 * The real package names whose directory owns at least one changed file —
 * deduped, sorted. A file maps to the LONGEST matching package dir, so a nested
 * package (`packages/governance/core`) wins over its parent
 * (`packages/governance`). Private packages ARE included (see the file header):
 * the point is the correct name, and a changeset may reference a private
 * package.
 */
export function packagesForFiles(changedFiles, index) {
  const names = new Set()
  for (const file of changedFiles) {
    let best = null
    for (const pkg of index) {
      if (file === pkg.dir || file.startsWith(pkg.dir + '/')) {
        if (!best || pkg.dir.length > best.dir.length) best = pkg
      }
    }
    if (best) names.add(best.name)
  }
  return [...names].sort()
}

function changedFiles(base) {
  const out = execFileSync('git', ['diff', '--name-only', `${base}...HEAD`], {
    cwd: ROOT,
    encoding: 'utf8',
  })
  return out.split('\n').map(s => s.trim()).filter(Boolean)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const base = process.argv[2] || 'origin/main'
  let files
  try {
    files = changedFiles(base)
  } catch (err) {
    console.error(`list-changed-packages: git diff against ${base} failed: ${err.message}`)
    process.exit(1)
  }
  for (const name of packagesForFiles(files, buildPackageIndex())) console.log(name)
}

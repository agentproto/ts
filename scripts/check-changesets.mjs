#!/usr/bin/env node
/**
 * Validate that every changeset names a real workspace package.
 *
 * `changeset version` hard-errors on an unknown package name — and it only runs
 * on main, after the merge. So a changeset naming a package that doesn't exist
 * takes down every release until someone notices.
 *
 * That is not hypothetical: `.changeset/pr-338-review.md` declared
 * "@agentproto/vscode" (the package is `agentproto-vscode`), and every Release
 * run failed from the moment #338 merged. Nothing caught it, because nothing
 * looked. Changesets are usually written by the agentic reviewer, which is
 * guessing the package name from context — exactly the kind of guess that needs
 * a check against the workspace.
 *
 * Cheap, dependency-free, and runs on the PR that introduces the changeset.
 *
 * Usage: node scripts/check-changesets.mjs
 * Exit:  0 = all good · 1 = at least one bad package name
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..')

/** Every package name declared in the workspace. */
function workspacePackages() {
  const names = new Set()
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
          if (pkg.name) names.add(pkg.name)
        } catch {
          /* unparseable package.json is not this script's problem */
        }
      }
    }
  }
  for (const g of globs) walk(resolve(ROOT, g))
  return names
}

/** Package names a changeset's frontmatter declares. */
function declaredPackages(md) {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md)
  if (!fm) return []
  const out = []
  for (const line of fm[1].split('\n')) {
    // `"@scope/name": minor` — quoted or bare, any bump type.
    const m = /^\s*["']?([^"':]+)["']?\s*:\s*(major|minor|patch)\s*$/.exec(line)
    if (m) out.push(m[1].trim())
  }
  return out
}

const known = workspacePackages()
if (known.size === 0) {
  console.error('Found no workspace packages — refusing to pass vacuously.')
  process.exit(1)
}

const dir = resolve(ROOT, '.changeset')
const files = existsSync(dir)
  ? readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'README.md')
  : []

let bad = 0
for (const f of files) {
  const md = readFileSync(resolve(dir, f), 'utf8')
  for (const name of declaredPackages(md)) {
    if (!known.has(name)) {
      // Surface the near-miss — the failure mode is a guessed name, so the real
      // one is usually a character away.
      const guess = [...known].find(
        (k) => k.replace(/[@/-]/g, '') === name.replace(/[@/-]/g, ''),
      )
      console.error(
        `✗ .changeset/${f}: "${name}" is not a workspace package.` +
          (guess ? ` Did you mean "${guess}"?` : ''),
      )
      bad++
    }
  }
}

if (bad > 0) {
  console.error(
    `\n${bad} bad package name(s). \`changeset version\` would fail on main and ` +
      `take down every release until fixed — which is exactly what pr-338-review did.`,
  )
  process.exit(1)
}
console.log(`✓ ${files.length} changeset(s), all package names resolve to the workspace.`)

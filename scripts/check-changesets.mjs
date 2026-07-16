#!/usr/bin/env node
/**
 * Validate that every changeset names a real workspace package — and, with
 * `--fix`, auto-correct the one failure mode that is deterministic.
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
 * The guess is almost always a *scoping* near-miss (`@agentproto/vscode` vs
 * `agentproto-vscode`), which resolves to exactly one real package. `--fix`
 * rewrites those in place, so the reviewer's guess self-heals before it lands
 * instead of reding every later PR's changeset check. A name that resolves to
 * zero or more-than-one workspace package is NOT auto-fixed — that needs a human.
 *
 * Cheap, dependency-free, and runs on the PR that introduces the changeset.
 *
 * Usage: node scripts/check-changesets.mjs [--fix]
 * Exit:  0 = all good (or all bad names auto-fixed) · 1 = an unresolvable name
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..')

/** Every package name declared in the workspace. */
export function workspacePackages(root = ROOT) {
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
  for (const g of globs) walk(resolve(root, g))
  return names
}

/** Package names a changeset's frontmatter declares. */
export function declaredPackages(md) {
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

/**
 * The single workspace package a bad name most likely meant — but only when the
 * answer is unambiguous. Normalising away `@`, `/`, `-` collapses the common
 * scope↔dash confusion (`@agentproto/vscode` ≡ `agentproto-vscode`). Returns
 * the match only if EXACTLY ONE workspace package normalises the same way;
 * zero or several → null (don't guess when it isn't obvious).
 */
export function nearestWorkspaceName(name, known) {
  const norm = (s) => s.replace(/[@/-]/g, '')
  const target = norm(name)
  const matches = [...known].filter((k) => norm(k) === target && k !== name)
  return matches.length === 1 ? matches[0] : null
}

/**
 * Rewrite a changeset's frontmatter, replacing each auto-resolvable bad name
 * with its workspace name. Pure — returns the new text plus what changed and
 * what couldn't be resolved. Only the frontmatter block is touched.
 */
export function fixChangeset(md, known) {
  const fm = /^(---\r?\n)([\s\S]*?)(\r?\n---)/.exec(md)
  const fixed = []
  const unresolved = []
  if (!fm) return { text: md, fixed, unresolved }
  const body = fm[2]
    .split('\n')
    .map((line) => {
      const m = /^(\s*["']?)([^"':]+?)(["']?\s*:\s*(?:major|minor|patch)\s*)$/.exec(line)
      if (!m) return line
      const name = m[2].trim()
      if (known.has(name)) return line
      const to = nearestWorkspaceName(name, known)
      if (!to) {
        unresolved.push(name)
        return line
      }
      fixed.push({ from: name, to })
      return `${m[1]}${to}${m[3]}`
    })
    .join('\n')
  const text = md.slice(0, fm.index) + fm[1] + body + fm[3] + md.slice(fm.index + fm[0].length)
  return { text, fixed, unresolved }
}

function main(argv) {
  const fix = argv.includes('--fix')
  const known = workspacePackages()
  if (known.size === 0) {
    console.error('Found no workspace packages — refusing to pass vacuously.')
    return 1
  }

  const dir = resolve(ROOT, '.changeset')
  const files = existsSync(dir)
    ? readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'README.md')
    : []

  let bad = 0
  let healed = 0
  for (const f of files) {
    const path = resolve(dir, f)
    let md = readFileSync(path, 'utf8')

    if (fix) {
      const { text, fixed } = fixChangeset(md, known)
      if (fixed.length) {
        writeFileSync(path, text)
        md = text
        healed += fixed.length
        for (const { from, to } of fixed) console.log(`✎ .changeset/${f}: "${from}" → "${to}"`)
      }
    }

    // Re-read from `md` (possibly just healed) so only names we CAN'T fix count.
    for (const name of declaredPackages(md)) {
      if (!known.has(name)) {
        const guess = nearestWorkspaceName(name, known)
        console.error(
          `✗ .changeset/${f}: "${name}" is not a workspace package.` +
            (guess ? ` Did you mean "${guess}"? (run with --fix)` : ''),
        )
        bad++
      }
    }
  }

  if (healed > 0) console.log(`✎ auto-corrected ${healed} package name(s).`)
  if (bad > 0) {
    console.error(
      `\n${bad} bad package name(s). \`changeset version\` would fail on main and ` +
        `take down every release until fixed — which is exactly what pr-338-review did.`,
    )
    return 1
  }
  console.log(`✓ ${files.length} changeset(s), all package names resolve to the workspace.`)
  return 0
}

// Only run when invoked directly — importing for tests pulls the pure exports.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)))
}

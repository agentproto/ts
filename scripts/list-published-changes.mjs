#!/usr/bin/env node
/**
 * Filter a list of changed `packages/**`/`adapters/**` paths down to the ones
 * that actually reach the npm-published surface — the exact question the
 * `changeset-check` job's presence gate needs answered, and which "is this
 * package private?" only approximates.
 *
 * Why "private?" isn't the right question: a package's `files[]` in
 * `package.json` is npm's own allowlist for what ships in the tarball (e.g.
 * `["dist", "README.md", "LICENSE"]`) — everything else in the package
 * directory (docs/, scripts/, tests/, source configs) never leaves the repo.
 * A docs-only change in a PUBLIC package (e.g. `packages/llm-endpoint/docs/
 * router-ux-design.md` — PR #690) demanded a changeset and a real npm bump for
 * zero shipped lines, purely because the old gate's test was a path-prefix
 * ("is this dir private") instead of a published-surface test. It happened to
 * pass only because llm-endpoint was `private` at the time; a private→public
 * flip (PR #1304) would have broken it.
 *
 * Every publishable workspace package here declares a `files[]` (verified
 * against all 120 as of writing) — this only reasons about that field, plus:
 *
 * - npm's implicit always-included root files: `package.json`, `README*`,
 *   `LICENSE*`/`LICENCE*`, `CHANGELOG*`.
 * - `src/**`, for any package that has a `src/` directory. `files[]` almost
 *   always names a *build output* (`dist`, or a skill-pack's generated
 *   `skills/`+`.claude-plugin/`, see `.gitignore`) rather than the source that
 *   produces it, and that output is gitignored — a plain diff never shows
 *   `dist/…` changing, only the `src/…` that gets compiled into it. Treating
 *   `files[]` as the *whole* test would make it look like ordinary source
 *   edits never touch the published surface, which is backwards. Checked
 *   across the workspace: every package with a `src/` directory ships
 *   something built from it (`dist`, or the skill-pack pair) — there is no
 *   case here where `src/` exists but isn't a build input.
 *
 * This deliberately does NOT reimplement npm-packlist's glob/`.npmignore`/
 * negation handling: none of that is in use in this workspace today (checked:
 * no `files[]` entry contains a glob metacharacter or a slash), and if a
 * package ever adds one, the fallback below treats it as "in doubt" and counts
 * the change as published — a tolerable false positive (an unneeded
 * changeset) beats the alternative (a missed release).
 *
 * A private package's changes are never published regardless of `files[]` —
 * that exemption still holds, it's now a special case of the general rule
 * (private packages contribute nothing to the published surface) rather than
 * the whole test.
 *
 * Usage: git diff --name-only <base>...HEAD -- 'packages/**' 'adapters/**' \
 *          | node scripts/list-published-changes.mjs
 * Prints the subset of stdin's paths that land in some package's published
 * npm surface, one per line. Empty output = no changeset required.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve, dirname, relative } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..')

// npm always includes these at a package's root regardless of `files[]`.
const IMPLICIT_ROOT_RE = /^(readme|license|licence|changelog)(\..+)?$/i

/**
 * `[{ dir, name, private, files, hasSrcDir }]` for every workspace package
 * under `packages/` and `adapters/`, where `dir` is relative to the repo root,
 * `files` is the raw `package.json` `files[]` array (or `null` if absent),
 * and `hasSrcDir` records whether the package has a committed `src/`
 * directory (see the file header — that's the build input `files[]` usually
 * names only the output of). Mirrors `list-changed-packages.mjs`'s
 * `buildPackageIndex`, plus `files`/`hasSrcDir`.
 */
export function buildPackageIndex(root = ROOT) {
  const out = []
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
            out.push({
              dir: relative(root, dir),
              name: pkg.name,
              private: pkg.private === true,
              files: Array.isArray(pkg.files) ? pkg.files : null,
              hasSrcDir: existsSync(resolve(dir, 'src')),
            })
          }
        } catch {
          /* unparseable package.json is not this script's problem */
        }
      }
    }
  }
  for (const g of ['packages', 'adapters']) walk(resolve(root, g))
  return out
}

/**
 * Does a path relative to its package root land in that package's published
 * npm surface? `files` is that package's raw `files[]` (or `null`);
 * `hasSrcDir` says whether the package has a committed `src/` directory (see
 * the file header for why that counts as published surface too).
 *
 * Matching against `files[]` is exact-segment, not glob: an entry `"dist"`
 * covers `dist` itself and everything under `dist/`, never a sibling like
 * `dist-tmp`.
 */
export function isPublishedPath(relPath, files, { hasSrcDir = false } = {}) {
  if (relPath === 'package.json') return true
  if (!relPath.includes('/') && IMPLICIT_ROOT_RE.test(relPath)) return true
  if (hasSrcDir && (relPath === 'src' || relPath.startsWith('src/'))) return true
  // No `files[]` declared: npm ships everything (minus its own default
  // ignores) — safest to treat every path as published rather than guess.
  if (!files) return true
  return files.some((entry) => relPath === entry || relPath.startsWith(`${entry}/`))
}

/**
 * The subset of `changedFiles` that reaches some package's published npm
 * surface. A file owned by no indexed package, or whose owning package we
 * can't resolve, counts as published (in doubt → require a changeset). A
 * file under a `private` package never counts, regardless of `files[]`.
 */
export function filterPublishedChanges(changedFiles, index) {
  const out = []
  for (const file of changedFiles) {
    let owner = null
    for (const pkg of index) {
      if (file === pkg.dir || file.startsWith(`${pkg.dir}/`)) {
        if (!owner || pkg.dir.length > owner.dir.length) owner = pkg
      }
    }
    if (!owner) {
      out.push(file)
      continue
    }
    if (owner.private) continue
    const relPath = file.slice(owner.dir.length + 1)
    if (isPublishedPath(relPath, owner.files, { hasSrcDir: owner.hasSrcDir })) out.push(file)
  }
  return out
}

function readStdin() {
  return new Promise((resolvePromise) => {
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => {
      data += chunk
    })
    process.stdin.on('end', () => resolvePromise(data))
  })
}

async function main() {
  const raw = await readStdin()
  const changedFiles = raw
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
  const index = buildPackageIndex()
  for (const file of filterPublishedChanges(changedFiles, index)) console.log(file)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code))
}

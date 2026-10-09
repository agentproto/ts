#!/usr/bin/env node
/**
 * Pre-check for the Release workflow's "publish what changesets/action
 * skipped" step: does any public workspace package carry a version that is
 * not on the npm registry yet?
 *
 * changesets/action only publishes when no changeset is pending; a changeset
 * landing on main between the version-PR creation and its merge (e.g. the
 * automated catalog sync) makes the post-merge run open a new version PR
 * instead, so the already-versioned packages never reach npm. This answers
 * "is there anything to publish?" cheaply, so the workflow only runs the
 * (build + publish) path when it has to.
 *
 * Fail-open: a registry answer other than 200/404 (network error, 5xx, 429)
 * counts the package as pending.
 *
 * Read-after-write lag: run right after changesets/action published, the
 * registry can still answer 404 for a version it just accepted (npm "staged"
 * versions). Release run 37863877434 (2026-10-09) read 58 fresh versions as
 * missing, `pending=true` fired the publish step again, `changeset publish`'s
 * own "already on npm?" check hit the same lag, and npm refused all 58 with
 * E409 "Cannot publish over previously staged version" — a red release over
 * a fully published batch. So a package is only reported pending after it
 * still reads missing across `SETTLE_ROUNDS` re-checks `SETTLE_MS` apart.
 *
 * Usage: node scripts/list-unpublished-packages.mjs
 * Prints `<name>@<version>` per unpublished package on stdout; writes
 * `pending=true|false` to $GITHUB_OUTPUT when set. Always exits 0 unless the
 * workspace itself can't be read.
 */
import { appendFileSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..')
const REGISTRY = process.env.NPM_CONFIG_REGISTRY?.replace(/\/$/, '') || 'https://registry.npmjs.org'
const CONCURRENCY = 16
const SETTLE_ROUNDS = Number(process.env.UNPUBLISHED_SETTLE_ROUNDS ?? 3)
const SETTLE_MS = Number(process.env.UNPUBLISHED_SETTLE_MS ?? 20_000)

/** Workspace globs of the form `dir/*` from pnpm-workspace.yaml. */
export function workspaceGlobs(yaml) {
  return [...yaml.matchAll(/^\s*-\s*["']?([^"'\s]+)\/\*["']?\s*$/gm)].map((m) => m[1])
}

/** Repo-relative dirs of every workspace package (one level under each pnpm-workspace `dir/*` glob). */
export function workspacePackageDirs(root = ROOT) {
  const dirs = []
  for (const base of workspaceGlobs(readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8'))) {
    const abs = join(root, base)
    if (!existsSync(abs)) continue
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(join(abs, entry.name, 'package.json'))) dirs.push(join(base, entry.name))
    }
  }
  return dirs
}

export function publicWorkspacePackages(root = ROOT) {
  const pkgs = []
  for (const dir of workspacePackageDirs(root)) {
    const { name, version, private: priv } = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'))
    if (!priv && name && version) pkgs.push({ name, version })
  }
  return pkgs
}

/** true = on npm, false = definitely not, null = couldn't tell. */
export async function isPublished({ name, version }, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(`${REGISTRY}/${name.replace('/', '%2f')}/${version}`)
    if (res.status === 200) return true
    if (res.status === 404) return false
    return null
  } catch {
    return null
  }
}

export async function listUnpublished(pkgs, fetchImpl = fetch, concurrency = CONCURRENCY) {
  const pending = []
  let next = 0
  async function worker() {
    while (next < pkgs.length) {
      const pkg = pkgs[next++]
      if ((await isPublished(pkg, fetchImpl)) !== true) pending.push(pkg)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, pkgs.length) }, worker))
  return pending.sort((a, b) => a.name.localeCompare(b.name))
}

/** {@link listUnpublished}, then re-check whatever reads pending up to
 *  `rounds` more times, `waitMs` apart — so a version the registry accepted
 *  moments ago (read-after-write lag) isn't reported as missing. */
export async function listUnpublishedSettled(pkgs, { fetchImpl = fetch, rounds = SETTLE_ROUNDS, waitMs = SETTLE_MS, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = console.error } = {}) {
  let pending = await listUnpublished(pkgs, fetchImpl)
  for (let round = 1; round <= rounds && pending.length > 0; round++) {
    log(`[list-unpublished-packages] ${pending.length} package(s) read as missing — re-checking in ${waitMs / 1000}s (${round}/${rounds}, registry lag)`)
    await sleep(waitMs)
    pending = await listUnpublished(pending, fetchImpl)
  }
  return pending
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pending = await listUnpublishedSettled(publicWorkspacePackages())
  for (const { name, version } of pending) console.log(`${name}@${version}`)
  console.error(`[list-unpublished-packages] ${pending.length} package(s) not on npm yet`)
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `pending=${pending.length > 0}\n`)
  }
}

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
 * counts the package as pending. `changeset publish` skips versions already on
 * npm, so a false positive costs a build, never a double publish.
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pending = await listUnpublished(publicWorkspacePackages())
  for (const { name, version } of pending) console.log(`${name}@${version}`)
  console.error(`[list-unpublished-packages] ${pending.length} package(s) not on npm yet`)
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `pending=${pending.length > 0}\n`)
  }
}

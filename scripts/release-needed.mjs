#!/usr/bin/env node
/**
 * Cheap half of the Release workflow's gate: is a changeset pending?
 *
 * The other half is scripts/list-unpublished-packages.mjs (is a version on main
 * missing from npm?). A push to main needs the (long) install + build +
 * changesets run only when one of the two says yes: a pending changeset means
 * the Version Packages PR has to be opened or updated, an unpublished version
 * means something has to be published. Every other push is a no-op that used to
 * pay for a full install and build first.
 *
 * Usage: node scripts/release-needed.mjs
 * Prints the pending changeset files; writes `pending=true|false` to
 * $GITHUB_OUTPUT when set.
 */
import { appendFileSync, existsSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..')

/** Changeset files waiting to be versioned: `.changeset/*.md` except the README. */
export function pendingChangesets(root = ROOT) {
  const dir = join(root, '.changeset')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md') && f.toLowerCase() !== 'readme.md')
    .sort()
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pending = pendingChangesets()
  for (const f of pending) console.log(f)
  console.error(`[release-needed] ${pending.length} pending changeset(s)`)
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `pending=${pending.length > 0}\n`)
}

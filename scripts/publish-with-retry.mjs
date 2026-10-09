#!/usr/bin/env node
// Wrap `pnpm release:ci` (the changesets publish step of the Release
// workflow) in a bounded retry for transient GitHub-side failures.
//
// On a big release, changesets/action's publish pushes ~100 git tags
// back-to-back, and GitHub's ref-write path has answered HTTP 429
// mid-burst (2026-09-29, run 36603549866): the step failed, the
// reconcile-release-tags.mjs step repaired the missing tags on the next
// run, but the "Version or publish" step itself stayed red. Retrying is
// safe here because `changeset publish` is idempotent — it skips
// versions already on npm — and the reconcile step repairs tags, so a
// re-run converges instead of double-publishing.
//
// Non-transient failures exit immediately with the original exit code —
// except one: a run whose ONLY failures are npm refusing a version that is
// already there (E409 "Cannot publish over previously staged version", E403
// "cannot publish over the previously published version"). That's the
// registry's read-after-write lag making `changeset publish` think a version
// it just published is missing (release run 37863877434, 2026-10-09: 58
// packages, all live). Nothing is left to publish, so it counts as success.

import { spawnSync } from 'node:child_process'

const TRANSIENT_SIGNATURES = [
  'HTTP 429',
  'fatal error in commit_refs',
  'remote rejected',
  'unexpected disconnect while reading sideband packet',
]

export function classifyFailure(output) {
  if (output == null) return 'non-transient'
  const text = String(output)
  return TRANSIENT_SIGNATURES.some((sig) => text.includes(sig))
    ? 'transient'
    : 'non-transient'
}

/** `changeset publish` reports each failed package as
 *  "an error occurred while publishing <name>: <reason>". */
const PUBLISH_ERROR = /an error occurred while publishing (\S+?):\s*(.*)/g
const ALREADY_PUBLISHED = /E409|EPUBLISHCONFLICT|cannot publish over (the )?previously (staged|published) version/i

/** The packages a failed run refused ONLY because the version already exists
 *  on npm — or null when any package failed for another reason, or no
 *  per-package failure was reported at all. */
export function alreadyPublishedOnly(output) {
  if (output == null) return null
  const names = new Set()
  for (const m of String(output).matchAll(PUBLISH_ERROR)) {
    if (!ALREADY_PUBLISHED.test(m[2])) return null
    names.add(m[1])
  }
  return names.size > 0 ? [...names] : null
}

const ATTEMPTS = 3
const BACKOFF_MS = [10_000, 30_000]

export async function runPublish({ command = 'pnpm release:ci', attempts = ATTEMPTS, backoffMs = BACKOFF_MS, log = console.error } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    log(`[publish-with-retry] attempt ${attempt}/${attempts}: ${command}`)
    const result = spawnSync(command, {
      shell: true,
      stdio: ['inherit', 'pipe', 'pipe'],
      encoding: 'utf8',
      env: { ...process.env, PUBLISH_WITH_RETRY_ATTEMPT: String(attempt) },
    })
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
    if (result.stdout) process.stdout.write(result.stdout)
    if (result.stderr) process.stderr.write(result.stderr)
    if (result.status === 0) {
      log(`[publish-with-retry] attempt ${attempt}/${attempts} succeeded`)
      return 0
    }
    const already = alreadyPublishedOnly(output)
    if (already) {
      log(`[publish-with-retry] every failure is an already-published version (${already.length} package(s): ${already.join(', ')}) — nothing left to publish, treating as success`)
      return 0
    }
    if (attempt === attempts) {
      log(`[publish-with-retry] attempt ${attempt}/${attempts} failed (exit ${result.status}) — giving up`)
      return result.status ?? 1
    }
    if (classifyFailure(output) !== 'transient') {
      log(`[publish-with-retry] failure does not look transient — not retrying (exit ${result.status})`)
      return result.status ?? 1
    }
    const wait = backoffMs[attempt - 1] ?? backoffMs[backoffMs.length - 1]
    log(`[publish-with-retry] transient failure (exit ${result.status}) — retrying in ${wait / 1000}s`)
    await new Promise((resolve) => setTimeout(resolve, wait))
  }
  return 1
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exit(await runPublish())
}

#!/usr/bin/env node
/**
 * Reconciles git tags + GitHub Releases against what's actually published to
 * npm, for every public workspace package.
 *
 * changesets/action pushes one git tag per published package, sequentially,
 * in a single burst. Pushing ~100 tags back-to-back in a few seconds has hit
 * GitHub's ref-write path hard enough to reject a chunk of them with
 * "fatal error in commit_refs" (2026-07-16, the #289 release: 15 of 98 tag
 * pushes rejected — a transient, GitHub-side error, not a bug in what we're
 * pushing). changesets/action then exits non-zero, which fails the whole
 * "Version or publish" step and skips everything after it in the same job
 * — the VS Code extension publish, the release notes, the docs-drift check
 * — even though every package had already published to npm successfully
 * (verified live: @agentproto/skill@0.2.0 was on the registry despite its
 * tag push failing).
 *
 * This script is the fix: for every non-private workspace package, compare
 * its expected tag (`<name>@<version>`, changesets' own naming) against
 * what's actually on the remote. A tag that's already there is left alone
 * — this makes the script idempotent, so running it after a fully
 * successful release finds nothing to do and exits clean. A missing tag is
 * only recreated if the version is confirmed live on the npm registry
 * (never invent a release for something that didn't actually publish); the
 * push is retried with backoff since the failure mode above is transient.
 * On a successful recreate, it also creates the matching GitHub Release
 * (skipped if one already exists) using the package's own CHANGELOG.md
 * entry for that version, matching changesets/action's own format.
 *
 * Usage:
 *   node scripts/reconcile-release-tags.mjs
 *   node scripts/reconcile-release-tags.mjs --dry-run
 *
 * Env:
 *   GH_TOKEN or GITHUB_TOKEN — required (gh CLI + git push over https)
 *
 * Exit codes:
 *   0 — nothing to do, or everything missing was successfully recovered
 *   1 — at least one missing tag could not be recovered after retries
 *
 * Writes `recovered=true|false` to $GITHUB_OUTPUT when that env var is set
 * (true iff at least one tag was actually recreated this run) — downstream
 * workflow steps can OR this into their own gate so a transient tag-push
 * failure never again cascades into skipping the rest of the release.
 */

import { execSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, appendFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const DRY_RUN = process.argv.includes('--dry-run')

function sh(cmd, opts = {}) {
  return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts })
}

function trySh(cmd, opts = {}) {
  try {
    return { ok: true, out: sh(cmd, opts) }
  } catch (err) {
    return { ok: false, out: (err.stdout || '') + (err.stderr || err.message || '') }
  }
}

function workspacePackageDirs() {
  const dirs = []
  for (const base of ['packages', 'adapters']) {
    if (!existsSync(base)) continue
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const dir = path.join(base, entry.name)
      if (existsSync(path.join(dir, 'package.json'))) dirs.push(dir)
    }
  }
  return dirs
}

function changelogSection(dir, version) {
  const changelogPath = path.join(dir, 'CHANGELOG.md')
  if (!existsSync(changelogPath)) return ''
  const lines = readFileSync(changelogPath, 'utf8').split('\n')
  let start = -1
  let end = lines.length
  for (let i = 0; i < lines.length; i++) {
    if (start === -1 && lines[i].trim() === `## ${version}`) {
      start = i + 1
      continue
    }
    if (start !== -1 && /^## /.test(lines[i])) {
      end = i
      break
    }
  }
  return start === -1 ? '' : lines.slice(start, end).join('\n').trim()
}

async function main() {
  let recovered = false
  let hadFailure = false

  for (const dir of workspacePackageDirs()) {
    const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'))
    if (pkg.private) continue
    // No CHANGELOG.md means changesets has never versioned this package —
    // e.g. packages/agentproto-placeholder, a manually-published npm
    // name-squat with no release history. Not ours to tag.
    if (!existsSync(path.join(dir, 'CHANGELOG.md'))) continue
    const tag = `${pkg.name}@${pkg.version}`

    const remoteHasTag = trySh(`git ls-remote --exit-code --tags origin "refs/tags/${tag}"`).ok
    if (remoteHasTag) continue

    const npmHasVersion = trySh(`npm view "${tag}" version`).ok
    if (!npmHasVersion) continue // never published (or not yet) — not ours to fix

    console.log(`::warning::${tag} missing on remote despite being live on npm — recreating`)
    if (DRY_RUN) {
      console.log(`  (dry-run) would tag + push + release ${tag}`)
      continue
    }

    trySh(`git tag -a "${tag}" -m "${tag}" HEAD`)

    let pushed = false
    for (let attempt = 1; attempt <= 3; attempt++) {
      const push = trySh(`git push origin "refs/tags/${tag}"`)
      if (push.ok) {
        pushed = true
        break
      }
      console.log(`  push attempt ${attempt}/3 failed for ${tag}: ${push.out.trim()}`)
      if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 5000))
    }

    if (!pushed) {
      console.log(`::error::failed to push ${tag} after 3 attempts — needs manual attention`)
      hadFailure = true
      continue
    }

    recovered = true

    const releaseExists = trySh(`gh release view "${tag}"`).ok
    if (releaseExists) continue

    const notes = changelogSection(dir, pkg.version)
    const notesFile = `/tmp/release-notes-${pkg.name.replace(/[^a-z0-9]/gi, '-')}.md`
    writeFileSync(notesFile, notes)
    const release = trySh(`gh release create "${tag}" --title "${tag}" --notes-file "${notesFile}"`)
    if (!release.ok) {
      console.log(`::warning::tag ${tag} pushed, but release creation failed: ${release.out.trim()}`)
    }
  }

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `recovered=${recovered}\n`)
  }

  process.exit(hadFailure ? 1 : 0)
}

main()

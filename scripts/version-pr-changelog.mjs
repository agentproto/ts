/**
 * Re-post the full per-package changelog of the "Version Packages" PR as
 * chunked comments when changesets/action had to truncate the PR body.
 *
 * changesets/action renders one section per bumped package into the PR body,
 * but GitHub caps a PR body at 65 536 chars. Past that cap the action does not
 * trim — it drops EVERY changelog and leaves bare `## pkg@version` headings
 * plus "The changelog information of each package has been omitted from this
 * message, as the content exceeds the size limit." (#1072: 241 files, 60
 * packages, zero lines of changelog to review before merging a release.)
 *
 * This script runs right after the action in version mode (the step is gated
 * on `steps.changesets.outputs.pullRequestNumber`). It diffs the release
 * branch against the base for CHANGELOG.md files, extracts each package's
 * section for the version the branch is about to publish, and posts the lot
 * as one or more issue comments, each under GitHub's comment cap. Comments are
 * marker-tagged and updated in place on every run, so re-runs (every push to
 * main updates the PR) never pile up duplicates. When the body was NOT
 * truncated the script deletes any stale comments it owns and exits 0.
 *
 * Usage:
 *   PR_NUMBER=<n> REPO=<owner/repo> node scripts/version-pr-changelog.mjs
 *   node scripts/version-pr-changelog.mjs --dry-run   # render + plan, post nothing
 *
 * Env:
 *   PR_NUMBER        the Version Packages PR (required unless --dry-run)
 *   REPO             owner/repo (defaults to GITHUB_REPOSITORY)
 *   RELEASE_BRANCH   defaults to changeset-release/main
 *   BASE_BRANCH      defaults to main
 *   GH_TOKEN         for `gh api`
 *
 * Exit code is always 0 on a soft failure (no PR, gh down) — this is a
 * reviewability bonus on top of an already-successful version step and must
 * never make the release job red. Every skip is surfaced as a ::warning::.
 */

import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

export const MARKER_PREFIX = '<!-- version-pr-changelog'
export const OMITTED_SENTENCE =
  'has been omitted from this message, as the content exceeds the size limit'
/** GitHub's issue-comment cap is 65 536 chars; leave headroom for the marker
 *  and header we prepend to each chunk. */
export const COMMENT_CAP = 60_000

const warn = (msg) => console.log(`::warning::version-pr-changelog: ${msg}`)

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
    ...opts,
  })
}

function trySh(cmd, args, opts = {}) {
  try {
    return { ok: true, out: sh(cmd, args, opts) }
  } catch (err) {
    return { ok: false, out: (err.stdout || '') + (err.stderr || err.message || '') }
  }
}

// ── pure helpers (unit-tested) ────────────────────────────────────────────────

/** The body of the `## <version>` section of a CHANGELOG, or '' when absent. */
export function changelogSection(text, version) {
  const lines = text.split('\n')
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

/** One collapsible block per package. Empty sections still render so a
 *  package that was bumped by dependency only is visibly accounted for. */
export function renderPackage({ name, version, section }) {
  const body = section && section.length > 0 ? section : '_(no changelog entry — bumped by dependency)_'
  return `<details>\n<summary><b>${name}@${version}</b></summary>\n\n${body}\n\n</details>`
}

export function marker(part, total, sha) {
  return `${MARKER_PREFIX} part=${part}/${total} sha=${sha} -->`
}

export function parseMarker(body) {
  const m = /<!-- version-pr-changelog part=(\d+)\/(\d+) sha=([0-9a-f]+) -->/.exec(body ?? '')
  if (!m) return null
  return { part: Number(m[1]), total: Number(m[2]), sha: m[3] }
}

/**
 * Pack rendered parts into chunks of at most `cap` chars, joined by blank
 * lines. A single part larger than the cap is hard-cut with a note rather than
 * silently dropped — better a truncated entry than a missing package.
 */
export function chunk(parts, cap = COMMENT_CAP) {
  const chunks = []
  let current = ''
  for (const raw of parts) {
    const part = raw.length > cap ? `${raw.slice(0, cap - 80)}\n\n_(entry truncated at ${cap} chars)_` : raw
    if (current.length === 0) {
      current = part
    } else if (current.length + 2 + part.length <= cap) {
      current = `${current}\n\n${part}`
    } else {
      chunks.push(current)
      current = part
    }
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

/** Header prepended to every chunk. Counts help a reader spot a missing part. */
export function chunkHeader({ part, total, packageCount, sha }) {
  const which = total > 1 ? ` (part ${part}/${total})` : ''
  return (
    `${marker(part, total, sha)}\n` +
    `### Full changelog for this release batch${which}\n\n` +
    `changesets/action omitted the per-package changelogs from the PR body ` +
    `(GitHub body size cap). ${packageCount} package${packageCount === 1 ? '' : 's'} ` +
    `bumped on \`${sha.slice(0, 7)}\`; each is collapsed below.`
  )
}

/**
 * Reconcile the comments we own against the chunks we want. `existing` is the
 * marker-tagged comments already on the PR (any order). Same-index comments
 * are updated in place (GitHub keeps their position), surplus ones deleted,
 * missing ones created. Comments whose body already matches are left alone so
 * a no-change re-run makes zero writes.
 */
export function planComments(existing, bodies) {
  const owned = [...existing]
    .filter((c) => parseMarker(c.body))
    .sort((a, b) => parseMarker(a.body).part - parseMarker(b.body).part)
  const update = []
  const create = []
  const remove = []
  const unchanged = []
  bodies.forEach((body, i) => {
    const target = owned[i]
    if (!target) create.push(body)
    else if (target.body === body) unchanged.push(target.id)
    else update.push({ id: target.id, body })
  })
  for (const extra of owned.slice(bodies.length)) remove.push(extra.id)
  return { update, create, remove, unchanged }
}

// ── git / gh plumbing ─────────────────────────────────────────────────────────

function gitShow(ref, path) {
  const r = trySh('git', ['show', `${ref}:${path}`])
  return r.ok ? r.out : null
}

/** Every package whose CHANGELOG changed between base and the release branch,
 *  with the version the release branch carries and that version's section. */
export function collectPackages({ base, release }) {
  const diff = trySh('git', ['diff', '--name-only', `${base}...${release}`, '--', '*CHANGELOG.md'])
  if (!diff.ok) throw new Error(`git diff failed: ${diff.out}`)
  const entries = []
  for (const file of diff.out.split('\n').map((s) => s.trim()).filter(Boolean)) {
    const dir = file.replace(/\/?CHANGELOG\.md$/, '')
    const pkgJson = gitShow(release, `${dir}/package.json`)
    if (!pkgJson) continue
    let pkg
    try {
      pkg = JSON.parse(pkgJson)
    } catch {
      continue
    }
    if (!pkg.name || !pkg.version) continue
    const changelog = gitShow(release, file) ?? ''
    entries.push({ name: pkg.name, version: pkg.version, section: changelogSection(changelog, pkg.version) })
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name))
}

function ghApi(method, path, body) {
  const args = ['api', '-X', method, path]
  const opts = {}
  if (body !== undefined) {
    args.push('--input', '-')
    opts.input = JSON.stringify(body)
  }
  const r = trySh('gh', args, opts)
  if (!r.ok) return { ok: false, json: null, out: r.out }
  try {
    return { ok: true, json: r.out.trim() ? JSON.parse(r.out) : null, out: r.out }
  } catch {
    return { ok: true, json: null, out: r.out }
  }
}

function listOwnedComments(repo, pr) {
  const r = trySh('gh', ['api', '--paginate', `repos/${repo}/issues/${pr}/comments?per_page=100`])
  if (!r.ok) throw new Error(`listing comments failed: ${r.out}`)
  // --paginate concatenates JSON arrays back to back; split them apart.
  const pages = r.out.trim().replace(/\]\s*\[/g, '],[')
  const all = JSON.parse(`[${pages}]`).flat()
  return all.filter((c) => parseMarker(c.body)).map((c) => ({ id: c.id, body: c.body }))
}

// ── main ──────────────────────────────────────────────────────────────────────

export async function main(argv = process.argv.slice(2), env = process.env) {
  const dryRun = argv.includes('--dry-run')
  const repo = env.REPO || env.GITHUB_REPOSITORY
  const pr = env.PR_NUMBER
  const baseName = env.BASE_BRANCH || 'main'
  const releaseName = env.RELEASE_BRANCH || 'changeset-release/main'
  const base = `origin/${baseName}`
  const release = `origin/${releaseName}`

  if (!dryRun && (!repo || !pr)) {
    warn('PR_NUMBER / REPO not set — nothing to do.')
    return 0
  }

  const fetched = trySh('git', ['fetch', '-q', 'origin', baseName, releaseName])
  if (!fetched.ok) warn(`git fetch failed (${fetched.out.trim().split('\n')[0]}) — using local refs.`)

  const shaR = trySh('git', ['rev-parse', release])
  if (!shaR.ok) {
    warn(`release branch ${release} not found — nothing to post.`)
    return 0
  }
  const sha = shaR.out.trim()

  let truncated = true
  if (!dryRun) {
    const view = ghApi('GET', `repos/${repo}/pulls/${pr}`)
    if (!view.ok) {
      warn(`could not read PR #${pr}: ${view.out.slice(0, 200)}`)
      return 0
    }
    truncated = (view.json?.body ?? '').includes(OMITTED_SENTENCE)
  }

  const packages = truncated ? collectPackages({ base, release }) : []
  const parts = packages.map(renderPackage)
  const raw = chunk(parts)
  const bodies = raw.map(
    (c, i) => `${chunkHeader({ part: i + 1, total: raw.length, packageCount: packages.length, sha })}\n\n${c}`,
  )

  if (dryRun) {
    console.log(
      `[dry-run] ${packages.length} package(s) on ${release} (${sha.slice(0, 7)}) → ${bodies.length} comment(s): ` +
        bodies.map((b) => `${b.length} chars`).join(', '),
    )
    if (bodies[0]) console.log(`\n${bodies[0].slice(0, 1500)}\n…`)
    return 0
  }

  if (!truncated) console.log(`PR #${pr} body carries its changelogs — cleaning up any stale comments.`)

  const existing = listOwnedComments(repo, pr)
  const plan = planComments(existing, bodies)
  for (const { id, body } of plan.update) {
    const r = ghApi('PATCH', `repos/${repo}/issues/comments/${id}`, { body })
    if (!r.ok) warn(`update of comment ${id} failed: ${r.out.slice(0, 200)}`)
  }
  for (const body of plan.create) {
    const r = ghApi('POST', `repos/${repo}/issues/${pr}/comments`, { body })
    if (!r.ok) warn(`create failed: ${r.out.slice(0, 200)}`)
  }
  for (const id of plan.remove) {
    const r = ghApi('DELETE', `repos/${repo}/issues/comments/${id}`)
    if (!r.ok) warn(`delete of comment ${id} failed: ${r.out.slice(0, 200)}`)
  }
  console.log(
    `PR #${pr}: ${packages.length} package(s), ${bodies.length} comment(s) — ` +
      `${plan.create.length} created, ${plan.update.length} updated, ${plan.unchanged.length} unchanged, ${plan.remove.length} removed.`,
  )
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      warn(err instanceof Error ? err.message : String(err))
      process.exit(0)
    })
}

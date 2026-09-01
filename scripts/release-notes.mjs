#!/usr/bin/env node
/**
 * Agentic release notes generator.
 *
 * Triggered after `changesets/action` publishes packages. Reads the
 * per-package CHANGELOGs, greps the codebase for context, and composes
 * a consolidated human-readable release announcement — then posts it as
 * the body of the highest-bumped package's GitHub Release.
 *
 * Usage:
 *   node scripts/release-notes.mjs               # auto-detect published packages
 *   node scripts/release-notes.mjs --dry-run     # render the body, post nothing
 *
 * Streams:
 *   stdout — the rendered release body, and nothing else (only under --dry-run).
 *   stderr — all progress, tool calls, and warnings.
 *
 *   The split is load-bearing, not style. `--dry-run | gh release edit
 *   --notes-file -` is a thing people reach for, and when the trace lived on
 *   stdout that pipe published the generator's own console log as the release
 *   body — see @agentproto/cli@0.5.0. Keep progress on stderr, and keep stdout
 *   to the body alone.
 *
 * Env:
 *   ANTHROPIC_API_KEY  — required
 *   GITHUB_TOKEN       — required for posting (not needed with --dry-run)
 *
 * Exit codes:
 *   0 — notes posted (or dry-run complete)
 *   1 — error
 */

import { execSync, execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// ── root ──────────────────────────────────────────────────────────────────────

function findGitRoot(start) {
  try {
    return execSync('git rev-parse --show-toplevel', { cwd: start, encoding: 'utf8', stdio: 'pipe' }).trim()
  } catch {
    return null
  }
}
const ROOT =
  findGitRoot(process.cwd()) ??
  findGitRoot(new URL('..', import.meta.url).pathname) ??
  new URL('..', import.meta.url).pathname.replace(/\/$/, '')

// ── CLI args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const DRY_RUN = args.includes('--dry-run')

// ── the date ──────────────────────────────────────────────────────────────────
//
// The model has no idea what day it is, so it used to invent one — which is how
// we ended up with releases tagged `release/2025-07` and titled "July 2025" for
// batches that shipped in 2026. Anything date-shaped is computed here and either
// handed to the model as fact or enforced on its output. Never asked for.
//
// The title used to be month-granular ("agentproto — July 2026 release"), on
// the unstated assumption that a batch like this ships about once a month. It
// doesn't — this repo cuts release batches multiple times a month, sometimes
// same-day, and month-granular titles collapsed distinct releases into
// identical, indistinguishable titles (two "July 2026 release"s, three "June
// 2026 release"s, before this was caught and the existing ones retitled).
// RELEASE_DATE_LONG matches the tag's own per-day granularity instead.

const NOW = new Date()
const TODAY = NOW.toISOString().slice(0, 10) // YYYY-MM-DD
const THIS_YEAR = String(NOW.getUTCFullYear())
const RELEASE_DATE_LONG = NOW.toLocaleString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
const CONSOLIDATED_TAG = `release/${TODAY}`

// ── logging ───────────────────────────────────────────────────────────────────
//
// Every progress line goes to stderr, deliberately. stdout used to carry this
// trace, so `release-notes.mjs --dry-run | gh release edit --notes-file -` would
// cheerfully publish the generator's own console log as a release body. That is
// exactly how @agentproto/cli@0.5.0's notes became 432 lines of "⟳ Turn 1 / 🔧
// read_changelog(name)". stdout is now reserved for the rendered body under
// --dry-run and nothing else, so piping it can only ever yield real notes.

const log = (...a) => console.error(...a)

// ── helpers ───────────────────────────────────────────────────────────────────

function run(cmd, opts = {}) {
  try {
    return execSync(cmd, { cwd: ROOT, encoding: 'utf8', ...opts }).trim()
  } catch {
    return ''
  }
}

/**
 * Refuse to publish anything that looks like this script's own output.
 *
 * The stderr split above makes the accidental-pipe route impossible, but a body
 * can still arrive looking like a log — a model echoing a previous run's trace,
 * a copy-paste, a future refactor that reintroduces the pipe. This is the gate
 * at the door: it inspects what is actually about to be published, so it holds
 * regardless of how the body got here.
 */
const TRACE_MARKERS = [
  /📦 Release notes generator/,
  /^⟳\s+Turn \d+/m,
  /^\s*🔧 \w+\(/m,
  /^\[DRY-RUN\]/m,
  /✅ Release notes complete/,
  /Would create consolidated release/,
  /Would update GitHub Release/,
]

function assertPublishable(body, what) {
  if (typeof body !== 'string' || body.trim().length < 200) {
    throw new Error(`refusing to publish ${what}: body is empty or implausibly short`)
  }
  if (!/^#\s+\S/m.test(body)) {
    throw new Error(`refusing to publish ${what}: body has no markdown heading — this is not a release note`)
  }
  for (const marker of TRACE_MARKERS) {
    if (marker.test(body)) {
      throw new Error(
        `refusing to publish ${what}: body contains generator trace output (matched ${marker}). ` +
          `This is the @agentproto/cli@0.5.0 failure mode — a console log was about to become a release body.`,
      )
    }
  }
}

// ── batch identity ────────────────────────────────────────────────────────────
//
// A release batch is identified by the sha of the `chore(release): version
// packages` commit it was cut from — the same commit tool_list_published_packages
// reads its package list out of, so the identity and the contents can't drift
// apart. Computed here, never supplied by the model, for the same reason the tag
// and the year are.
//
// The marker rides in the published body as an HTML comment (invisible on
// GitHub). The model writes the prose; this code appends the marker, so it can't
// be forged, omitted, or hallucinated.

const BATCH_MARKER_RE = /<!--\s*agentproto-batch:\s*([0-9a-f]{7,40})\s*-->/i

const batchMarker = (sha) => `<!-- agentproto-batch: ${sha} -->`

/** The batch sha a published body claims, or null (legacy body, or no marker). */
function bodyBatchSha(body) {
  const m = BATCH_MARKER_RE.exec(typeof body === 'string' ? body : '')
  return m ? m[1] : null
}

/** Append the marker to a model-written body. No sha ⇒ nothing to stamp. */
function appendBatchMarker(body, sha) {
  if (!sha || typeof body !== 'string') return body
  if (bodyBatchSha(body) === sha) return body
  return `${body.replace(/\s+$/, '')}\n\n${batchMarker(sha)}\n`
}

/**
 * Where to look for the batch's version-bump commit. NOT the checkout's HEAD:
 * in a version-mode run (pending changesets → "Version Packages" PR),
 * changesets/action leaves the working tree on ITS OWN fresh
 * `chore(release): version packages` commit — the head of
 * `changeset-release/main`, not on main at all. A `force_post_release_steps`
 * backfill on such a run used to grep that commit first and publish notes for
 * the *unmerged* batch (2026-09-01: `release/2026-09-01` announced cli@0.16.1
 * and runtime@2.10.1 while npm carried 0.16.0 / 2.10.0). `GITHUB_SHA` is the
 * commit the workflow was triggered for — always on the branch that was
 * pushed — so the walk starts there. Outside Actions, HEAD is the only truth.
 */
function batchLookupRef(env = process.env) {
  return env.GITHUB_SHA || 'HEAD'
}

/** File contents at a commit (`git show sha:path`), or null when absent. */
function readAtCommit(sha, relPath) {
  if (!sha || !relPath) return null
  try {
    return execFileSync('git', ['show', `${sha}:${relPath}`], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 16 * 1024 * 1024,
    })
  } catch {
    return null
  }
}

/** The sha of the version-bump commit this run is publishing notes for. */
function currentBatchSha() {
  return run(`git log ${batchLookupRef()} --grep="chore(release): version packages" -1 --format=%H`) || null
}

/**
 * Pick which tag this batch gets written to, and whether that's a create or an
 * edit. Walks `release/<date>`, `release/<date>.2`, `.3`, … until it finds a tag
 * that is either free or already carries *this* batch's marker.
 *
 * The distinction this draws is the one the old code missed: re-running the same
 * batch (the `force_post_release_steps` backfill, a reconcile-driven re-run) is
 * idempotent and must edit in place; publishing a *different* batch on the same
 * day is a new release and must get its own tag. Both used to land in the same
 * `catch` and overwrite.
 *
 * A legacy release with no marker — every consolidated release published before
 * this fix — reads as "not this batch" and so falls through to `.2`. That is the
 * deliberately safe direction: a spurious `.2` is trivially recoverable by hand,
 * a wiped release is not. It self-heals within a day, once every release on the
 * current date carries a marker.
 *
 * `fetchBody(tag)` returns the existing release body, or null if no release
 * exists at that tag.
 */
function selectReleaseTarget({ baseTag, batchSha, fetchBody, maxAttempts = 20 }) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const tag = attempt === 1 ? baseTag : `${baseTag}.${attempt}`
    const existing = fetchBody(tag)
    if (existing === null || existing === undefined) return { tag, attempt, mode: 'create' }
    // No batchSha ⇒ this run can't prove which batch it is, so it never claims
    // someone else's release. It mints a fresh tag instead of editing blind.
    if (batchSha && bodyBatchSha(existing) === batchSha) return { tag, attempt, mode: 'edit' }
  }
  // Cap the walk: a pathological state must fail loudly, not spin.
  throw new Error(
    `refusing to publish: ${maxAttempts} same-day tags from ${baseTag} are all held by other batches`,
  )
}

/** The model writes the title; it doesn't get to number it. Same rule as the tag. */
function suffixTitle(title, attempt) {
  const base = String(title ?? '').replace(/\s*\(\d+\)\s*$/, '')
  return attempt <= 1 ? base : `${base} (${attempt})`
}

// ── tool implementations ──────────────────────────────────────────────────────

/**
 * Discover packages published in the latest release commit.
 * `changesets/action` commits with "chore(release): version packages",
 * so we look at what changed in the most recent such commit.
 */
function tool_list_published_packages() {
  // Find the latest version-bump commit from changesets/action
  const releaseCommit = run(
    `git log ${batchLookupRef()} --oneline --grep="chore(release): version packages" -1`,
  )
  if (!releaseCommit) {
    // Fallback: find all @agentproto packages that have a CHANGELOG with a recent entry
    const pkgJsonPaths = run(
      'find packages adapters -maxdepth 3 -name "package.json" -not -path "*/node_modules/*"'
    ).split('\n').filter(Boolean)

    const published = []
    for (const p of pkgJsonPaths) {
      try {
        const { name, version, private: priv } = JSON.parse(readFileSync(resolve(ROOT, p), 'utf8'))
        if (!name?.startsWith('@agentproto/') || priv) continue
        const changelogPath = p.replace('package.json', 'CHANGELOG.md')
        if (existsSync(resolve(ROOT, changelogPath))) {
          published.push({ name, version, changelogPath })
        }
      } catch {}
    }
    return JSON.stringify(published, null, 2)
  }

  // Parse the commit hash and inspect changed CHANGELOG files
  const commitHash = releaseCommit.split(' ')[0]
  const changedFiles = run(`git diff-tree --no-commit-id -r --name-only ${commitHash}`).split('\n').filter(Boolean)
  const changelogs = changedFiles.filter((f) => f.endsWith('CHANGELOG.md'))

  const published = []
  for (const changelogPath of changelogs) {
    const pkgJsonPath = changelogPath.replace('CHANGELOG.md', 'package.json')
    try {
      // Versions come from the batch commit itself, never the working tree —
      // on a version-mode run the tree already carries the NEXT bump.
      const raw = readAtCommit(commitHash, pkgJsonPath) ?? readFileSync(resolve(ROOT, pkgJsonPath), 'utf8')
      const { name, version, private: priv } = JSON.parse(raw)
      if (!name?.startsWith('@agentproto/') || priv) continue
      published.push({ name, version, changelogPath })
    } catch {}
  }
  return published.length > 0
    ? JSON.stringify(published, null, 2)
    : '(no packages published in latest release commit — try after `changeset version` is merged)'
}

function tool_read_changelog({ name, maxChars = 6_000 }) {
  if (!name) return '(no package name provided)'
  // Find the package dir
  const pkgJsonPaths = run(
    'find packages adapters -maxdepth 3 -name "package.json" -not -path "*/node_modules/*"'
  ).split('\n').filter(Boolean)

  for (const p of pkgJsonPaths) {
    try {
      const { name: pkgName } = JSON.parse(readFileSync(resolve(ROOT, p), 'utf8'))
      if (pkgName !== name) continue
      const changelogRel = p.replace('package.json', 'CHANGELOG.md')
      const changelogPath = resolve(ROOT, changelogRel)
      // Same rule as list_published_packages: the batch commit's CHANGELOG, so
      // the top entry is the version that shipped, not the next pending bump.
      const content =
        readAtCommit(currentBatchSha(), changelogRel) ??
        (existsSync(changelogPath) ? readFileSync(changelogPath, 'utf8') : null)
      if (content === null) return `(no CHANGELOG.md found for ${name})`
      // Return only the latest version block (up to maxChars)
      const trimmed = content.length > maxChars ? content.slice(0, maxChars) + '\n... (truncated)' : content
      return trimmed
    } catch {}
  }
  return `(package not found: ${name})`
}

function tool_read_file({ path }) {
  if (!path) return '(no path)'
  const abs = resolve(ROOT, path)
  if (!existsSync(abs)) return `(file not found: ${path})`
  try {
    const content = readFileSync(abs, 'utf8')
    return content.length > 8_000 ? content.slice(0, 8_000) + '\n... (truncated)' : content
  } catch {
    return `(could not read: ${path})`
  }
}

function tool_grep_repo({ pattern, glob = '' }) {
  if (!pattern) return '(no pattern)'
  try {
    const result = execSync(
      `grep -rn --include="*.ts" --include="*.mjs" --include="*.md" -m 5 ${JSON.stringify(pattern)} packages/ adapters/ 2>/dev/null | head -40`,
      { cwd: ROOT, encoding: 'utf8' }
    ).trim()
    return result || '(no matches)'
  } catch {
    return '(no matches)'
  }
}

function tool_list_git_tags() {
  return run('git tag --sort=-version:refname | grep "^@agentproto" | head -20') || '(no tags)'
}

function tool_post_release_notes({ tag, body }) {
  if (!tag || !body) return '(tag and body are required)'
  try {
    assertPublishable(body, `release notes for ${tag}`)
  } catch (e) {
    return `(${e.message})`
  }
  if (DRY_RUN) {
    log(`\n[dry-run] would update GitHub Release ${tag} — body on stdout`)
    process.stdout.write(body)
    return `dry-run: release notes not posted for ${tag}`
  }
  try {
    // Update the existing GitHub Release created by changesets/action
    execFileSync('gh', ['release', 'edit', tag, '--notes', body], {
      cwd: ROOT, encoding: 'utf8', stdio: 'pipe',
    })
    return `✓ Updated GitHub Release ${tag}`
  } catch {
    // Release might not exist yet — create it
    try {
      execFileSync('gh', ['release', 'create', tag, '--notes', body, '--title', tag], {
        cwd: ROOT, encoding: 'utf8', stdio: 'pipe',
      })
      return `✓ Created GitHub Release ${tag}`
    } catch (e) {
      return `Error posting release notes: ${e.message}`
    }
  }
}

/** Existing release body for a tag, or null when no release exists there. */
function fetchReleaseBody(tag) {
  try {
    return execFileSync('gh', ['release', 'view', tag, '--json', 'body', '--jq', '.body'], {
      cwd: ROOT, encoding: 'utf8', stdio: 'pipe',
    })
  } catch {
    // Non-zero exit = no release at this tag. (A bare git tag with no release
    // also lands here, which is correct: `gh release create` handles that.)
    return null
  }
}

function tool_post_consolidated_release({ title, body }) {
  // The tag is computed, never supplied. The model used to be able to pass one
  // and it picked from its own sense of the date — `release/2025-07` for a batch
  // published in July 2026. There is no reason the author of the prose should
  // also get to name the tag.
  const batchSha = currentBatchSha()
  try {
    assertPublishable(body, `consolidated release ${CONSOLIDATED_TAG}`)
  } catch (e) {
    return `(${e.message})`
  }
  // Stamp the batch identity onto the body *after* the gate, so what gets
  // published is exactly what was inspected plus a marker this code controls.
  const markedBody = appendBatchMarker(body, batchSha)
  // Same reasoning as the tag for the title: the model writes it, so it can still
  // smuggle a hallucinated year into the prose. Correct it rather than reject —
  // the year is knowable, and a retry loop over a fact we already hold is waste.
  let safeTitle = title
  const wrongYear = /\b(20\d{2})\b/.exec(safeTitle ?? '')
  if (wrongYear && wrongYear[1] !== THIS_YEAR) {
    log(`   ⚠️  title said ${wrongYear[1]}, correcting to ${THIS_YEAR}`)
    safeTitle = safeTitle.replace(wrongYear[1], THIS_YEAR)
  }
  if (!safeTitle) safeTitle = `agentproto — ${RELEASE_DATE_LONG} release`

  if (DRY_RUN) {
    log(`\n[dry-run] would post consolidated release "${safeTitle}" (${CONSOLIDATED_TAG}) — body on stdout`)
    process.stdout.write(markedBody)
    return `dry-run: consolidated release not posted (tag: ${CONSOLIDATED_TAG})`
  }

  // Which tag, and create or edit? Not "create, and overwrite whatever's there
  // on failure" — that conflated an idempotent re-run of *this* batch with a
  // second, different batch publishing the same day, and the second one silently
  // replaced the first one's title and body. See selectReleaseTarget.
  let target
  try {
    target = selectReleaseTarget({ baseTag: CONSOLIDATED_TAG, batchSha, fetchBody: fetchReleaseBody })
  } catch (e) {
    return `Error: ${e.message}`
  }
  const finalTitle = suffixTitle(safeTitle, target.attempt)
  if (target.attempt > 1) {
    log(`   ⚠️  ${CONSOLIDATED_TAG} holds another batch's release — publishing to ${target.tag}`)
  }

  // `--latest=true` on whichever release this batch writes: this is the one a
  // human should land on. changesets publishes ~37 per-package releases per batch,
  // and GitHub was picking whichever sorted last as "Latest" — it settled on
  // `runtime-profile-standard@0.1.1`, a package nobody installs, while the real
  // notes sat on an unlinked tag. The consolidated release exists on every run
  // regardless of which packages shipped, so it is the only stable thing to point
  // at; the newest batch of the day should win it.
  const verb = target.mode === 'create' ? 'create' : 'edit'
  try {
    execFileSync('gh', ['release', verb, target.tag, '--title', finalTitle, '--notes', markedBody, '--latest=true'], {
      cwd: ROOT, encoding: 'utf8', stdio: 'pipe',
    })
  } catch (e) {
    // Deliberately no create→edit fallback. A create that fails here means the
    // state moved under us (a concurrent run took the tag) — the safe answer is
    // to fail and let a human look, not to overwrite a release we never read.
    return `Error posting consolidated release ${target.tag}: ${e.message}`
  }
  return target.mode === 'create'
    ? `✓ Created consolidated GitHub Release: ${target.tag}`
    : `✓ Updated consolidated GitHub Release: ${target.tag} (same batch, in place)`
}

// ── tool dispatch ─────────────────────────────────────────────────────────────

const TOOLS = {
  list_published_packages: tool_list_published_packages,
  read_changelog: tool_read_changelog,
  read_file: tool_read_file,
  grep_repo: tool_grep_repo,
  list_git_tags: tool_list_git_tags,
  post_release_notes: tool_post_release_notes,
  post_consolidated_release: tool_post_consolidated_release,
}

const TOOL_DEFS = [
  {
    name: 'list_published_packages',
    description: 'List @agentproto/* packages that were just published in the latest release, with their versions and CHANGELOG paths.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'read_changelog',
    description: 'Read the CHANGELOG.md for a specific @agentproto package (latest version block first).',
    input_schema: {
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string', description: '@agentproto/package-name' },
        maxChars: { type: 'number', description: 'Truncate at this many chars (default: 6000)' },
      },
    },
  },
  {
    name: 'read_file',
    description: 'Read any file in the repo relative to the repo root.',
    input_schema: {
      type: 'object',
      required: ['path'],
      properties: {
        path: { type: 'string' },
      },
    },
  },
  {
    name: 'grep_repo',
    description: 'Search the codebase for a pattern across .ts, .mjs, .md files.',
    input_schema: {
      type: 'object',
      required: ['pattern'],
      properties: {
        pattern: { type: 'string' },
        glob: { type: 'string' },
      },
    },
  },
  {
    name: 'list_git_tags',
    description: 'List recent @agentproto git tags (for version context).',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'post_release_notes',
    description: 'Update the body of an existing per-package GitHub Release (created by changesets/action).',
    input_schema: {
      type: 'object',
      required: ['tag', 'body'],
      properties: {
        tag: { type: 'string', description: 'GitHub Release tag, e.g. "@agentproto/agent@0.2.0"' },
        body: { type: 'string', description: 'Markdown release notes body' },
      },
    },
  },
  {
    name: 'post_consolidated_release',
    description: 'Create (or update) a single consolidated GitHub Release that summarises the whole batch of package publishes.',
    input_schema: {
      type: 'object',
      required: ['title', 'body'],
      properties: {
        title: { type: 'string', description: `Release title. Must be "agentproto — ${RELEASE_DATE_LONG} release".` },
        body: { type: 'string', description: 'Full markdown announcement' },
        // No `tag` property, on purpose: the tag is computed from the system
        // clock. See tool_post_consolidated_release.
      },
    },
  },
]

// ── system prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a technical writer and developer advocate for the @agentproto open-standards project.

Your job: compose a **consolidated, human-readable release announcement** for the latest batch of @agentproto package publishes.

## Today's date

Today is **${TODAY}** (**${RELEASE_DATE_LONG}**), and the current year is
**${THIS_YEAR}**.

Use those values verbatim wherever the announcement needs a date. Do not infer
the date from your own training, from version numbers, or from anything you read
in the repo — you will get it wrong. This project ships release batches far
more often than monthly, sometimes more than once in the same week — never
describe this as "the ${NOW.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' })} release"
or imply it is the only release of its month; it is one dated batch among
several. The title must read exactly:
\`agentproto — ${RELEASE_DATE_LONG} release\`.

## Workflow

1. Call \`list_published_packages\` to see what was released and at which version.
2. Call \`read_changelog\` for each published package to read the per-package CHANGELOG entries.
3. Use \`read_file\` and \`grep_repo\` **freely** to understand the actual code behind each change — don't just paraphrase the CHANGELOG, dig into what was built and why it matters.
4. Call \`list_git_tags\` for version context.
5. Write the announcement (see format below), then call \`post_consolidated_release\` to publish it.

## Release announcement format

\`\`\`markdown
# agentproto — ${RELEASE_DATE_LONG} release

> [One-sentence hook about the most significant thing in this release]

## What's new

### [Feature name] ([package]@[version])
[2-4 sentences explaining what it is, why it matters, and how to use it. Concrete — show the type signature or a short code example if it helps.]

### [Next feature] (...)
...

## Package versions

| Package | Version | Bump |
|---|---|---|
| \`@agentproto/agent\` | \`0.2.0\` | minor |
| ... | | |

## Installing / upgrading

\`\`\`bash
npm install @agentproto/agent@latest @agentproto/mcp-server@latest ...
\`\`\`

## Full changelogs
[Links to each package's CHANGELOG.md on GitHub]
\`\`\`

## Tone
- Technical but accessible. Assume the reader knows TypeScript and agents.
- Lead with the user benefit, not the implementation detail.
- Short paragraphs. Concrete examples > abstract descriptions.
- No hype words ("revolutionary", "powerful", "amazing").
- Use the imperative for feature names: "Add extends-chain validation", not "Extends-chain validation was added".
`

// ── agentic loop ──────────────────────────────────────────────────────────────

// Checked when the loop actually runs, not at import. A top-level process.exit
// here means importing this module for a test kills the test runner — which it
// did, the first time CI ran the tests below.
function requireApiKey() {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    log('Error: ANTHROPIC_API_KEY is not set.')
    process.exit(1)
  }
  return apiKey
}

async function callClaude(messages) {
  const apiKey = requireApiKey()
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 8192,
      system: SYSTEM_PROMPT,
      tools: TOOL_DEFS,
      messages,
    }),
  })
  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Anthropic API ${response.status}: ${body}`)
  }
  return response.json()
}

async function runAgenticLoop() {
  log(`\n📦 Release notes generator starting${DRY_RUN ? ' (dry-run)' : ''}…`)

  const messages = [
    {
      role: 'user',
      content: `Please generate release notes for the latest @agentproto package publishes.

Start by calling list_published_packages to see what was released, then read the CHANGELOGs and dig into the actual code to understand each change. Then compose a consolidated announcement and post it with post_consolidated_release.`,
    },
  ]

  let iterations = 0
  const MAX_ITER = 25

  while (iterations < MAX_ITER) {
    iterations++
    log(`\n⟳  Turn ${iterations}`)

    const resp = await callClaude(messages)
    messages.push({ role: 'assistant', content: resp.content })

    const toolUses = resp.content.filter((b) => b.type === 'tool_use')

    if (toolUses.length === 0) {
      const text = resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
      if (text) log('\n' + text)
      break
    }

    const toolResults = []
    for (const use of toolUses) {
      const fn = TOOLS[use.name]
      let result
      if (!fn) {
        result = `(unknown tool: ${use.name})`
      } else {
        log(`   🔧 ${use.name}(${Object.keys(use.input ?? {}).join(', ')})`)
        try {
          result = fn(use.input ?? {})
        } catch (e) {
          result = `(tool error: ${e.message})`
        }
        if (typeof result === 'string' && result.length > 12_000) {
          result = result.slice(0, 12_000) + '\n\n... (truncated)'
        }
      }
      toolResults.push({
        type: 'tool_result',
        tool_use_id: use.id,
        content: String(result),
      })
    }

    messages.push({ role: 'user', content: toolResults })

    if (resp.stop_reason === 'end_turn') break
  }

  if (iterations >= MAX_ITER) {
    log(`\n⚠️  Reached max iterations (${MAX_ITER}) — stopping.`)
  }

  log('\n✅ Release notes complete.')
}

// Only drive the agent when run as a script. Importing this file (tests) must
// not fire a real release.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runAgenticLoop()
}

export {
  batchLookupRef,
  readAtCommit,
  assertPublishable,
  TRACE_MARKERS,
  CONSOLIDATED_TAG,
  RELEASE_DATE_LONG,
  THIS_YEAR,
  TODAY,
  appendBatchMarker,
  batchMarker,
  bodyBatchSha,
  selectReleaseTarget,
  suffixTitle,
}

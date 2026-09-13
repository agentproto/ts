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
 *   node scripts/release-notes.mjs               # generate + post for the current batch
 *   node scripts/release-notes.mjs --dry-run     # render the body, post nothing
 *   node scripts/release-notes.mjs --check       # exit 0 iff a consolidated release
 *                                                #   already carries this batch's marker
 *                                                #   (3 otherwise) — the CI ladder's gate
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
 * Billing: the model runs through the Claude Agent SDK on ONE lane per
 * invocation, selected by `AGENT_LANE` (see scripts/lib/agent-lane.mjs):
 * subscription | subscription-fallback | openrouter | moonshot | api-key. The
 * release workflow walks those lanes in order until `--check` passes, so a
 * single dead credential (2026-09-01: two Anthropic orgs and a Moonshot
 * account, all "balance too low" within the hour) no longer leaves a batch
 * without notes. Unset ⇒ the first lane whose credential is present.
 *
 * Env:
 *   AGENT_LANE         — lane to run (optional, see above)
 *   <lane credential>  — CLAUDE_CODE_OAUTH_TOKEN / CLAUDE_CODE_OAUTH_TOKEN_FALLBACK /
 *                        OPENROUTER_API_KEY / MOONSHOT_API_KEY / ANTHROPIC_API_KEY
 *   AGENT_MODEL        — override the lane's default model (optional)
 *   GITHUB_TOKEN       — required for posting / --check (not needed with --dry-run)
 *
 * The runner, not the model, owns everything that must be exact: the batch
 * identity (marker), the tag, the title/date, and the publishable-body gate.
 * The model only writes prose and reads the repo with Read/Grep/Glob.
 *
 * Exit codes:
 *   0 — notes posted (or dry-run complete, or --check found the release)
 *   1 — error (no lane, generation failed, body not publishable)
 *   3 — --check: no consolidated release carries this batch's marker
 */

import { execSync, execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describeLane, pickLane, resolveLane } from './lib/agent-lane.mjs'
import { makeConfineToRepoRoot } from './lib/path-confine.mjs'

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
const CHECK = args.includes('--check')

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

// ── batch context ─────────────────────────────────────────────────────────────
//
// Everything the model needs to know about the batch is computed HERE, from
// the version-bump commit, and handed over verbatim. It used to discover the
// batch itself through custom tools that read package.json from the working
// tree — which, on a version-mode run, already carries the NEXT bump.

function releaseCommitHash() {
  const line = run(`git log ${batchLookupRef()} --oneline --grep="chore(release): version packages" -1`)
  return line ? line.split(' ')[0] : null
}

/** The body of the `## <version>` section of a CHANGELOG, or '' when absent. */
function changelogSection(text, version) {
  const lines = String(text ?? '').split('\n')
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

/**
 * @agentproto packages bumped in the batch commit, each with its CHANGELOG
 * entry for the shipped version — read AT the commit, never from the tree.
 */
function listPublishedPackages(commitHash) {
  if (!commitHash) return []
  const changed = run(`git diff-tree --no-commit-id -r --name-only ${commitHash}`).split('\n').filter(Boolean)
  const published = []
  for (const changelogPath of changed.filter((f) => f.endsWith('CHANGELOG.md'))) {
    const pkgJsonPath = changelogPath.replace('CHANGELOG.md', 'package.json')
    try {
      const raw = readAtCommit(commitHash, pkgJsonPath) ?? readFileSync(resolve(ROOT, pkgJsonPath), 'utf8')
      const { name, version, private: priv } = JSON.parse(raw)
      if (!name?.startsWith('@agentproto/') || priv) continue
      const abs = resolve(ROOT, changelogPath)
      const changelog =
        readAtCommit(commitHash, changelogPath) ?? (existsSync(abs) ? readFileSync(abs, 'utf8') : '')
      published.push({ name, version, changelogPath, entry: changelogSection(changelog, version) })
    } catch {}
  }
  return published.sort((a, b) => a.name.localeCompare(b.name))
}

function listGitTags() {
  return run('git tag --sort=-version:refname | grep "^@agentproto" | head -20') || '(no tags)'
}

const clip = (text, max) => (text.length > max ? `${text.slice(0, max)}\n… (truncated)` : text)

function buildContext() {
  const commitHash = releaseCommitHash()
  return { commitHash, packages: listPublishedPackages(commitHash), tags: listGitTags() }
}

/** The user message: the batch, verbatim, so the model never has to guess. */
function renderContext({ commitHash, packages, tags }) {
  const blocks = packages.map(
    (p) =>
      `### ${p.name}@${p.version}\n\n` +
      `CHANGELOG: \`${p.changelogPath}\`\n\n` +
      clip(p.entry || '_(no entry — bumped by dependency only)_', 6_000),
  )
  return [
    '## Batch',
    '',
    `Version-bump commit: \`${commitHash ?? 'unknown'}\``,
    '',
    `## Packages published (${packages.length})`,
    '',
    blocks.join('\n\n'),
    '',
    '## Recent @agentproto tags',
    '',
    '```',
    tags,
    '```',
  ].join('\n')
}

// ── publishing (runner-owned) ─────────────────────────────────────────────────

/** Existing release body for a tag, or null when no release exists there. */
function fetchReleaseBody(tag) {
  try {
    return execFileSync('gh', ['release', 'view', tag, '--json', 'body', '--jq', '.body'], {
      cwd: ROOT, encoding: 'utf8', stdio: 'pipe',
    })
  } catch {
    return null
  }
}

/** A final message may arrive wrapped in one outer code fence; unwrap it. */
function unwrapFence(text) {
  const t = String(text ?? '').trim()
  const m = /^```(?:markdown|md)?\r?\n([\s\S]*?)\r?\n```$/.exec(t)
  return m ? m[1].trim() : t
}

/**
 * Create (or update in place, same batch) the consolidated release. The tag,
 * title, date, and batch marker are all computed here — the model's body is
 * the only thing it contributed, and it passes the publishable gate first.
 */
function publishConsolidated(body) {
  const batchSha = currentBatchSha()
  assertPublishable(body, `consolidated release ${CONSOLIDATED_TAG}`)
  const markedBody = appendBatchMarker(body, batchSha)
  const title = `agentproto — ${RELEASE_DATE_LONG} release`
  if (DRY_RUN) {
    log(`\n[dry-run] would post consolidated release "${title}" (${CONSOLIDATED_TAG}) — body on stdout`)
    process.stdout.write(markedBody)
    return { tag: CONSOLIDATED_TAG, attempt: 1, mode: 'dry-run' }
  }
  const target = selectReleaseTarget({ baseTag: CONSOLIDATED_TAG, batchSha, fetchBody: fetchReleaseBody })
  const finalTitle = suffixTitle(title, target.attempt)
  if (target.attempt > 1) log(`   ⚠️  ${CONSOLIDATED_TAG} holds another batch's release — publishing to ${target.tag}`)
  const verb = target.mode === 'create' ? 'create' : 'edit'
  execFileSync('gh', ['release', verb, target.tag, '--title', finalTitle, '--notes', markedBody, '--latest=true'], {
    cwd: ROOT, encoding: 'utf8', stdio: 'pipe',
  })
  return target
}

// ── --check: does a consolidated release already carry this batch? ───────────

/** The release whose body carries `sha`'s batch marker, or null. Pure. */
function findBatchRelease(releases, sha) {
  if (!sha || !Array.isArray(releases)) return null
  return releases.find((r) => bodyBatchSha(r?.body) === sha) ?? null
}

function listRecentReleases() {
  const repo = process.env.GITHUB_REPOSITORY || run('gh repo view --json nameWithOwner --jq .nameWithOwner')
  if (!repo) return []
  try {
    return JSON.parse(run(`gh api "repos/${repo}/releases?per_page=60"`) || '[]')
  } catch {
    return []
  }
}

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

1. The batch — every published package, its version, and its CHANGELOG entry
   for exactly that version — is given to you verbatim in the user message.
   Trust it. Do NOT re-derive versions from package.json on disk: the working
   tree may already carry the *next* bump.
2. Use Read / Grep / Glob **freely** to understand the actual code behind each
   change — don't just paraphrase the CHANGELOG, dig into what was built and
   why it matters.
3. Write the announcement in the format below.
4. Your FINAL message must be the complete markdown announcement and NOTHING
   else — no preamble, no "here is the release note", no closing remark, no
   code fence around the whole thing. It is published verbatim. It must start
   with the H1 title line.

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

// ── generation (Claude Agent SDK, one lane) ───────────────────────────────────

async function generateBody(resolved, context) {
  // Lazy: --check and the unit tests must not need the SDK installed.
  const { query } = await import('@anthropic-ai/claude-agent-sdk')
  const confineToRepoRoot = makeConfineToRepoRoot(ROOT)
  const abortController = new AbortController()
  const prompt =
    'Please generate the consolidated release notes for this batch of @agentproto package publishes. ' +
    'Read the code behind the changes with Read/Grep/Glob, then reply with the announcement only.\n\n' +
    renderContext(context)
  const result = query({
    prompt,
    options: {
      model: resolved.model,
      env: resolved.env,
      cwd: ROOT,
      systemPrompt: SYSTEM_PROMPT,
      abortController,
      // Unattended CI run: nobody can answer a permission prompt. The
      // PreToolUse hook confines every read to the repo root.
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      hooks: { PreToolUse: [{ hooks: [confineToRepoRoot] }] },
      settingSources: [],
      tools: ['Read', 'Grep', 'Glob'],
      maxTurns: 40,
      ...(resolved.thinking ? { thinking: { type: 'enabled' } } : {}),
    },
  })
  let final = null
  for await (const message of result) {
    if (message.type === 'assistant') {
      for (const block of message.message?.content ?? []) {
        if (block.type === 'tool_use') log(`   🔧 ${block.name}(${Object.keys(block.input ?? {}).join(', ')})`)
      }
    } else if (message.type === 'result') {
      final = message
    }
  }
  if (!final) throw new Error('the agent produced no result message (stream ended without one)')
  if (final.is_error || final.subtype !== 'success') {
    throw new Error(`agent ended with ${final.subtype}: ${String(final.result ?? '').slice(0, 300)}`)
  }
  const cost = typeof final.total_cost_usd === 'number' ? ` · $${final.total_cost_usd.toFixed(4)}` : ''
  log(`   ${final.num_turns} turn(s)${cost}`)
  return unwrapFence(final.result)
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (CHECK) {
    const sha = currentBatchSha()
    const hit = findBatchRelease(listRecentReleases(), sha)
    if (hit) {
      log(`✓ consolidated release for batch ${sha.slice(0, 7)} exists: ${hit.tag_name}`)
      return 0
    }
    log(`✗ no consolidated release carries batch marker ${sha ? sha.slice(0, 7) : '(no batch commit found)'}`)
    return 3
  }

  const laneName = pickLane()
  if (!laneName) {
    log(
      'Error: no agent lane credential set — need one of CLAUDE_CODE_OAUTH_TOKEN, ' +
        'CLAUDE_CODE_OAUTH_TOKEN_FALLBACK, OPENROUTER_API_KEY, ANTHROPIC_API_KEY, MOONSHOT_API_KEY.',
    )
    return 1
  }
  const resolved = resolveLane(laneName)
  if (resolved.missing) {
    log(`Error: lane ${describeLane(resolved)}`)
    return 1
  }

  const context = buildContext()
  log(
    `\n📦 Release notes generator starting${DRY_RUN ? ' (dry-run)' : ''} — lane ${describeLane(resolved)} · ` +
      `batch ${context.commitHash ?? '(none)'} · ${context.packages.length} package(s)…`,
  )
  if (context.packages.length === 0) {
    log('Error: no published packages found in the batch commit — nothing to announce.')
    return 1
  }

  const body = await generateBody(resolved, context)
  const target = publishConsolidated(body)
  if (target.mode === 'dry-run') log(`\n✅ Release notes rendered (dry-run, tag would be ${target.tag}).`)
  else log(`\n✅ ${target.mode === 'create' ? 'Created' : 'Updated'} consolidated GitHub Release: ${target.tag}`)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      log(`Error: ${err instanceof Error ? err.message : String(err)}`)
      process.exit(1)
    })
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
  changelogSection,
  findBatchRelease,
  renderContext,
  unwrapFence,
}

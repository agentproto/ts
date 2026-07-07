#!/usr/bin/env node
/**
 * Agentic docs-check.
 *
 * Triggered after `changesets/action` publishes packages (mirrors
 * release-notes.mjs's trigger). Reads what was actually released — the
 * per-package CHANGELOG entries — and checks the hand-maintained docs
 * (`docs/**`, `README.md`, per-package `README.md`) for drift: a new CLI
 * verb/flag with no doc mention, a behavior change the getting-started guide
 * still describes the old way, a doc referencing something the release
 * removed. Where it finds drift, it edits the doc file directly. It never
 * invents new doc files — only existing ones are in scope.
 *
 * Runs on Moonshot's `kimi-k2.7-code` via the Claude Agent SDK's gateway mode
 * (cheap enough to run on every release without burning Anthropic spend) —
 * see adapters/claude-sdk/src/options.ts for the auth-hygiene rules this
 * mirrors (never let ANTHROPIC_API_KEY reach a third-party gateway) and for
 * why `bypassPermissions` is required: this runs unattended in CI, with no
 * human able to answer a tool-permission prompt.
 *
 * The workflow step that runs this script is responsible for diffing the
 * tree afterward and opening a PR if anything changed — this script only
 * makes edits (or, in --dry-run, only reports what it would edit).
 *
 * Usage:
 *   node scripts/docs-check.mjs               # edits docs in place (release-triggered)
 *   node scripts/docs-check.mjs --dry-run     # read-only, reports findings
 *   node scripts/docs-check.mjs --path 'docs/agents.md'            # on-demand, scoped to one doc
 *   node scripts/docs-check.mjs --path 'docs/**' --base origin/main # on-demand, scoped area, custom diff base
 *
 * Modes:
 *   release (default) — reads the latest `chore(release): version packages`
 *                       commit's CHANGELOGs and checks all hand-maintained docs
 *                       for drift against what just shipped. CI-triggered.
 *   path-scoped        --path <glob> skips the release requirement and constrains
 *                       edits to files matching the glob. Grounded in the recent
 *                       code diff vs --base (default origin/main) so the agent
 *                       knows what to verify. Use between releases or to audit a
 *                       single doc against the current code.
 *
 * Env:
 *   MOONSHOT_API_KEY   — required (the gateway bearer)
 *   ANTHROPIC_API_KEY  — must NOT be set for this to reach the gateway; if it
 *                        is set, it is scrubbed before the SDK spawns its child
 *                        (see buildEnv below) so it can never leak to Moonshot.
 *
 * Exit codes:
 *   0 — completed (edits made, or none needed, or dry-run report printed)
 *   1 — error (missing key, SDK error)
 */

import { query } from '@anthropic-ai/claude-agent-sdk'
import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// ── root ──────────────────────────────────────────────────────────────────

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

// ── CLI args ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const DRY_RUN = args.includes('--dry-run')

function readValue(flag) {
  const i = args.indexOf(flag)
  if (i === -1 || i === args.length - 1) return null
  return args[i + 1]
}

// --path <glob>: switch from release-triggered to on-demand, path-scoped mode.
// --base <ref>: diff base for the path-scoped "what changed" signal (default
//               origin/main). Ignored in release mode.
const PATH_GLOB = readValue('--path')
const BASE_REF = readValue('--base') || 'origin/main'
if (args.includes('--path') && !PATH_GLOB) {
  console.error('Error: --path requires a glob argument (e.g. --path "docs/agents.md").')
  process.exit(1)
}

function run(cmd) {
  try {
    return execSync(cmd, { cwd: ROOT, encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

// ── discover what was just published ───────────────────────────────────────
//
// Same approach as release-notes.mjs's tool_list_published_packages: find the
// changesets/action version-bump commit and read the CHANGELOG.md files it
// touched. Kept as plain code here (not an SDK tool) since docs-check only
// needs this once, up front, to seed the prompt.

function listPublishedPackages() {
  const releaseCommit = run(`git log --oneline --grep="chore(release): version packages" -1`)
  if (!releaseCommit) return []

  const commitHash = releaseCommit.split(' ')[0]
  const changedFiles = run(`git diff-tree --no-commit-id -r --name-only ${commitHash}`)
    .split('\n')
    .filter(Boolean)
  const changelogs = changedFiles.filter((f) => f.endsWith('CHANGELOG.md'))

  const published = []
  for (const changelogPath of changelogs) {
    const pkgJsonPath = changelogPath.replace('CHANGELOG.md', 'package.json')
    try {
      const { name, version, private: priv } = JSON.parse(readFileSync(resolve(ROOT, pkgJsonPath), 'utf8'))
      if (!name?.startsWith('@agentproto/') || priv) continue
      published.push({ name, version, changelogPath })
    } catch {}
  }
  return published
}

function readLatestChangelogEntry(changelogPath, maxChars = 4_000) {
  const abs = resolve(ROOT, changelogPath)
  if (!existsSync(abs)) return '(no CHANGELOG.md found)'
  const content = readFileSync(abs, 'utf8')
  return content.length > maxChars ? content.slice(0, maxChars) + '\n... (truncated)' : content
}

// ── recent changes (path-scoped mode only) ──────────────────────────────────
//
// In path-scoped mode there's no release to anchor on, so ground the agent in
// the recent code diff vs BASE_REF instead: the commits and changed-file list
// since the base. Compact on purpose — the agent reads the actual code, this
// just tells it what to verify. Resolves to a merge-base so a divergent branch
// only reports its own new commits, not everything since the branch point.

function collectRecentChanges(baseRef, maxChars = 6_000) {
  const base = run(`git merge-base ${baseRef} HEAD`) || baseRef
  const log = run(`git log --oneline ${base}..HEAD -n 30`)
  const stat = run(`git diff --stat ${base}..HEAD`)
  if (!log && !stat) return `(no recent changes detected vs ${baseRef})`
  const summary = `Recent commits (since ${baseRef}):\n${log || '(none)'}\n\nChanged files:\n${stat || '(none)'}`
  return summary.length > maxChars ? summary.slice(0, maxChars) + '\n... (truncated)' : summary
}

// ── prompt ──────────────────────────────────────────────────────────────────

let prompt
let scopeLabel

if (PATH_GLOB) {
  // On-demand, path-scoped run: no release required. Ground the agent in the
  // recent code diff vs BASE_REF (so it knows what to verify) and constrain
  // edits to the glob. This is the "run docs-check locally on one feature"
  // path — useful between releases, or to audit a single doc against code.
  const changes = collectRecentChanges(BASE_REF)
  scopeLabel = `path-scoped: ${PATH_GLOB}`
  prompt = `You are running docs-check on demand, scoped to a specific area of the agentproto docs.

Scope: only check and edit doc files matching this glob (relative to the repo root):
  ${PATH_GLOB}

Recent changes in the repo (vs ${BASE_REF}), for context — verify the scoped docs against these AND the current code:
${changes}

Your job: read the doc file(s) in scope, read the code they reference (via Grep/Glob/Read), and fix any drift — a doc describing behavior that no longer matches the code.

What counts as drift:
- A new CLI verb, flag, or option shipped but no doc mentions it.
- A doc describes behavior that the code changed (renamed flag, changed default, removed feature) and still shows the old behavior.
- A doc references something the code removed or renamed.

What does NOT count as drift — leave these alone:
- Internal refactors, test changes, or anything with no user-facing surface.
- Prose style, wording preferences, or anything that isn't factually wrong.
- Missing docs for something that ALREADY existed (that's backlog, not drift).

Rules:
- Only edit docs that are factually stale against the current code. Don't invent new sections or speculate about intent beyond what the code shows you.
- Only edit existing files. Never create a new doc file.
- Read the actual code (via Grep/Glob/Read) behind a doc claim before editing it — don't guess, verify it.
- Only edit files matching the scope glob above. Never edit or create files outside it.
- If you find nothing stale, do nothing and say so — don't manufacture a change to justify the run.
${DRY_RUN ? '- This is a DRY RUN: do not edit any files. Instead, report exactly which doc(s) you would change and why.' : ''}

When you're done, summarize what you changed (or confirm nothing needed changing).`
} else {
  const published = listPublishedPackages()
  if (published.length === 0) {
    console.log('docs-check: no packages published in the latest release commit — nothing to check.')
    process.exit(0)
  }

  const releaseSummary = published
    .map(({ name, version, changelogPath }) => `### ${name}@${version}\n\n${readLatestChangelogEntry(changelogPath)}`)
    .join('\n\n---\n\n')
  scopeLabel = `release: ${published.length} package(s)`

  prompt = `A release of @agentproto packages just published. Here is what changed, per package, from each CHANGELOG's latest entry:

${releaseSummary}

Your job: check the hand-maintained docs for drift against what actually just shipped, and fix any you find.

Where to look:
- \`docs/**\` (CLI verb/flag docs, getting-started guides, HARNESS-DESIGN.md, etc.)
- The root \`README.md\`
- Each published package's own \`README.md\` (same directory as its CHANGELOG.md)

What counts as drift:
- A new CLI verb, flag, or option shipped but no doc mentions it.
- A doc describes behavior that this release changed (renamed flag, changed default, removed feature) and still shows the old behavior.
- A doc references something this release removed or renamed.

What does NOT count as drift — leave these alone:
- Internal refactors, test changes, or anything with no user-facing surface.
- Prose style, wording preferences, or anything that isn't factually wrong.
- Missing docs for something that ALREADY existed before this release (that's backlog, not drift from this release).

Rules:
- Only edit docs that are factually stale because of THIS release. Don't invent new sections or speculate about intent beyond what the CHANGELOG + surrounding code shows you.
- Only edit existing files. Never create a new doc file.
- Read the actual code (via Grep/Glob/Read) behind a CHANGELOG line before editing a doc about it — don't paraphrase the CHANGELOG, verify it.
- If you find nothing stale, do nothing and say so — don't manufacture a change to justify the run.
${DRY_RUN ? '- This is a DRY RUN: do not edit any files. Instead, report exactly which doc(s) you would change and why.' : ''}

When you're done, summarize what you changed (or confirm nothing needed changing).`
}

// ── auth / env hygiene ───────────────────────────────────────────────────────
//
// Mirrors adapters/claude-sdk/src/options.ts's gateway-mode env building: a
// gateway base_url means ANTHROPIC_API_KEY must never be sent (it would 401
// against Moonshot, and would leak the real Anthropic key to a third party),
// and any CLAUDE_CODE_USE_* cloud-provider redirect leaked from a parent
// Claude Code shell must be scrubbed so it doesn't out-rank ANTHROPIC_BASE_URL.

const MOONSHOT_BASE_URL = 'https://api.moonshot.ai/anthropic'
const MODEL = 'kimi-k2.7-code'

const CLOUD_PROVIDER_REDIRECT_TOGGLES = [
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_GATEWAY',
]

function buildEnv() {
  const bearer = process.env.ANTHROPIC_AUTH_TOKEN ?? process.env.MOONSHOT_API_KEY
  if (!bearer) {
    console.error('Error: MOONSHOT_API_KEY (or ANTHROPIC_AUTH_TOKEN) is not set.')
    process.exit(1)
  }
  const env = { ...process.env }
  delete env.ANTHROPIC_API_KEY
  for (const key of CLOUD_PROVIDER_REDIRECT_TOGGLES) delete env[key]
  env.ANTHROPIC_BASE_URL = MOONSHOT_BASE_URL
  env.ANTHROPIC_AUTH_TOKEN = bearer
  env.ANTHROPIC_MODEL = MODEL
  env.ANTHROPIC_DEFAULT_OPUS_MODEL = MODEL
  env.ANTHROPIC_DEFAULT_SONNET_MODEL = MODEL
  env.ANTHROPIC_DEFAULT_HAIKU_MODEL = MODEL
  env.ANTHROPIC_SMALL_FAST_MODEL = MODEL
  return env
}

// ── run ───────────────────────────────────────────────────────────────────
//
// permissionMode: 'bypassPermissions' (+ its required companion
// allowDangerouslySkipPermissions) is unavoidable here: this runs unattended
// in a GitHub Actions job, with no human able to answer a tool-permission
// prompt. The blast radius is bounded instead by `allowedTools` — Read/Grep/
// Glob always, Edit only outside --dry-run; no Bash, no Write, so the worst
// case is an unwanted edit to an existing doc file, never arbitrary exec or
// new files.

async function main() {
  console.log(`\n📚 docs-check starting${DRY_RUN ? ' (dry-run)' : ''} — ${scopeLabel}, model ${MODEL}…`)

  const abortController = new AbortController()
  const result = query({
    prompt,
    options: {
      model: MODEL,
      abortController,
      cwd: ROOT,
      env: buildEnv(),
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      settingSources: [],
      includePartialMessages: false,
      thinking: { type: 'enabled' },
      allowedTools: DRY_RUN ? ['Read', 'Grep', 'Glob'] : ['Read', 'Grep', 'Glob', 'Edit'],
      maxTurns: 40,
    },
  })

  let finalResult = null
  for await (const message of result) {
    if (message.type === 'assistant') {
      for (const block of message.message.content ?? []) {
        if (block.type === 'text' && block.text) console.log('\n' + block.text)
        if (block.type === 'tool_use') {
          const input = Object.entries(block.input ?? {})
            .map(([k, v]) => `${k}=${JSON.stringify(v).slice(0, 80)}`)
            .join(', ')
          console.log(`   🔧 ${block.name}(${input})`)
        }
      }
    } else if (message.type === 'result') {
      finalResult = message
    }
  }

  if (!finalResult) {
    console.error('Error: docs-check produced no result message.')
    process.exit(1)
  }
  if (finalResult.is_error) {
    console.error(`Error: docs-check ended with an error (stop_reason: ${finalResult.stop_reason}).`)
    console.error(finalResult.result)
    process.exit(1)
  }

  console.log(`\n✅ docs-check complete (${finalResult.num_turns} turns, $${finalResult.total_cost_usd.toFixed(4)}).`)
}

await main()

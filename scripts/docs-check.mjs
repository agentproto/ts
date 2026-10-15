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
 * Supports OpenCode's free-model lane as well as the legacy Claude Agent SDK
 * lanes. The release workflow uses the shared `opencode-free` preset (MiMo,
 * then Step 5), so routine doc maintenance does not consume Anthropic spend.
 *
 * The workflow step that runs this script is responsible for diffing the
 * tree afterward and opening a PR if anything changed — this script only
 * makes edits (or, in --dry-run, only reports what it would edit).
 *
 * Usage:
 *   node scripts/docs-check.mjs               # edits docs in place (release-triggered)
 *   node scripts/docs-check.mjs --dry-run     # read-only, reports findings
 *   node scripts/docs-check.mjs --print-cloud-prompt # print a remote patch-producing prompt
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
 *   AGENT_LANE         — billing lane (see scripts/lib/agent-lane.mjs); unset ⇒ first lane
 *                        whose credential is present (opencode-free → legacy lanes)
 *   <lane credential>  — OPENCODE_API_KEY / CLAUDE_CODE_OAUTH_TOKEN /
 *                        …_FALLBACK / OPENROUTER_API_KEY / ANTHROPIC_API_KEY
 *   ANTHROPIC_API_KEY  — must NOT be set for this to reach the gateway; if it
 *                        is set, it is scrubbed before the SDK spawns its child
 *                        (see buildEnv below) so it can never leak to OpenRouter.
 *
 * Exit codes:
 *   0 — completed (edits made, or none needed, or dry-run report printed), or
 *       a soft failure (SDK error, turn-cap, no result message) — this is a
 *       best-effort bonus on top of an already-published release and must
 *       never redden that job; see the try/catch in main() below.
 *   1 — hard error before the SDK run even started (missing API key)
 */

import { execFileSync, execSync, spawn } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { makeConfineToRepoRoot } from './lib/path-confine.mjs'
import { describeLane, pickLane, resolveLane } from './lib/agent-lane.mjs'

// ── root ──────────────────────────────────────────────────────────────────

function findGitRoot(start) {
  try {
    return execSync('git rev-parse --show-toplevel', {
      cwd: start,
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim()
  } catch {
    return null
  }
}
const ROOT = findGitRoot(process.cwd()) ?? findGitRoot(new URL('..', import.meta.url).pathname) ?? new URL('..', import.meta.url).pathname.replace(/\/$/, '')

// ── CLI args ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const DRY_RUN = args.includes('--dry-run')
const PRINT_CLOUD_PROMPT = args.includes('--print-cloud-prompt')

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
  const changedFiles = run(`git diff-tree --no-commit-id -r --name-only ${commitHash}`).split('\n').filter(Boolean)
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

  const releaseSummary = published.map(({ name, version, changelogPath }) => `### ${name}@${version}\n\n${readLatestChangelogEntry(changelogPath)}`).join('\n\n---\n\n')
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

if (PRINT_CLOUD_PROMPT) {
  console.log(`${prompt}

CLOUD TRANSFER MODE:
- Work in your remote checkout and make any necessary in-scope doc edits there.
- Your FINAL response must be exactly the resulting unified git diff, with no prose and no markdown fence.
- If no edits are needed, respond with exactly NO_CHANGES.
- Never commit, push, open a pull request, or call an external service.`)
  process.exit(0)
}

// ── auth / env hygiene ───────────────────────────────────────────────────────
//
// Mirrors adapters/claude-sdk/src/options.ts's gateway-mode env building: a
// gateway base_url means ANTHROPIC_API_KEY must never be sent (it would 401
// against OpenRouter, and would leak the real Anthropic key to a third party),
// and any CLAUDE_CODE_USE_* cloud-provider redirect leaked from a parent
// Claude Code shell must be scrubbed so it doesn't out-rank ANTHROPIC_BASE_URL.

// ── billing lane ─────────────────────────────────────────────────────────────
//
// One lane per invocation, picked by AGENT_LANE (see scripts/lib/agent-lane.mjs):
// opencode-free | subscription | subscription-fallback | openrouter | api-key. The release
// workflow walks the lanes in order until this step reports `status=ok`, so a
// dead credential (2026-09-01: "suspended due to insufficient balance") no
// longer means no docs check at all. The lane env is built with every OTHER
// lane's credential scrubbed — a stale ANTHROPIC_API_KEY on the runner must
// never out-rank the lane asked for.

const LANE_NAME = pickLane()
const LANE = LANE_NAME ? resolveLane(LANE_NAME) : null
const MODEL = LANE?.model ?? '(no lane)'

/** Surface the outcome to the workflow (`steps.<id>.outputs.status`) so the
 *  ladder can decide whether to try the next lane. Always exits 0 — this step
 *  is a best-effort bonus and must never redden a release on its own. */
function emitStatus(status) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `status=${status}\n`)
  console.log(`docs-check status: ${status}`)
}

function buildEnv() {
  if (!LANE || LANE.missing) {
    console.error(`Error: no usable agent lane — ${LANE ? describeLane(LANE) : 'no credential set (CLAUDE_CODE_OAUTH_TOKEN / OPENROUTER_API_KEY / ANTHROPIC_API_KEY)'}.`)
    emitStatus('no-lane')
    process.exit(0)
  }
  return LANE.env
}

const confineToRepoRoot = makeConfineToRepoRoot(ROOT)

function workingTreePaths() {
  const split = (value) => value.toString('utf8').split('\0').filter(Boolean)
  const changed = execFileSync('git', ['diff', '--name-only', '-z', 'HEAD'], {
    cwd: ROOT,
  })
  const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: ROOT })
  return new Set([...split(changed), ...split(untracked)])
}

function globRegex(glob) {
  let pattern = '^'
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]
    if (char === '*' && glob[i + 1] === '*') {
      pattern += '.*'
      i++
    } else if (char === '*') pattern += '[^/]*'
    else if (char === '?') pattern += '[^/]'
    else pattern += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&')
  }
  return new RegExp(pattern + '$')
}

function isAllowedDocPath(path) {
  if (PATH_GLOB) return globRegex(PATH_GLOB).test(path)
  return path === 'README.md' || path.startsWith('docs/') || path.endsWith('/README.md')
}

function restoreDisallowedChanges(before) {
  const introduced = [...workingTreePaths()].filter((path) => !before.has(path) && !isAllowedDocPath(path))
  for (const path of introduced) {
    let tracked = false
    try {
      execFileSync('git', ['ls-files', '--error-unmatch', '--', path], {
        cwd: ROOT,
        stdio: 'ignore',
      })
      tracked = true
    } catch {}
    if (tracked) {
      execFileSync('git', ['restore', '--source=HEAD', '--staged', '--worktree', '--', path], { cwd: ROOT })
    } else {
      const absolute = resolve(ROOT, path)
      if (absolute.startsWith(ROOT + '/')) rmSync(absolute, { recursive: true, force: true })
    }
  }
  if (introduced.length) throw new Error(`OpenCode attempted changes outside the docs scope: ${introduced.join(', ')}`)
}

function runOpenCode(env) {
  const before = workingTreePaths()
  const inlineConfig = {
    small_model: MODEL,
    permission: {
      read: 'allow',
      edit: DRY_RUN ? 'deny' : 'allow',
      bash: 'deny',
      external_directory: 'deny',
      webfetch: 'deny',
    },
  }
  const childEnv = {
    ...env,
    OPENCODE_CONFIG_CONTENT: JSON.stringify(inlineConfig),
    OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
    OPENCODE_DISABLE_PROJECT_CONFIG: '1',
  }

  return new Promise((resolvePromise, reject) => {
    const child = spawn('opencode', ['run', '--pure', '--model', MODEL], {
      cwd: ROOT,
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('error', reject)
    child.on('close', (code) => {
      try {
        restoreDisallowedChanges(before)
        if (code !== 0) throw new Error(`OpenCode exited ${code}: ${stderr.slice(-500)}`)
        if (stdout.trim()) console.log(stdout.trim())
        resolvePromise()
      } catch (error) {
        reject(error)
      }
    })
    child.stdin.end(prompt)
  })
}

// ── run ───────────────────────────────────────────────────────────────────

async function main() {
  const env = buildEnv()
  console.log(`\n📚 docs-check starting${DRY_RUN ? ' (dry-run)' : ''} — ${scopeLabel}, lane ${describeLane(LANE)}…`)

  if (LANE.lane === 'opencode-free') {
    try {
      await runOpenCode(env)
      console.log('\n✅ docs-check complete (OpenCode).')
      emitStatus('ok')
    } catch (error) {
      console.warn(`\n⚠️  docs-check did not finish cleanly: ${error.message}`)
      emitStatus('error')
    }
    return
  }

  const { query } = await import('@anthropic-ai/claude-agent-sdk')
  const abortController = new AbortController()
  const result = query({
    prompt,
    options: {
      model: MODEL,
      abortController,
      cwd: ROOT,
      env,
      // bypassPermissions: this runs unattended in CI, with no human able to
      // answer a permission prompt (mirrors adapters/claude-sdk's own
      // unattended-arm rationale). The PreToolUse hook below is a separate
      // mechanism from the interactive permission system and still fires
      // under this mode — verified live — so it's the actual enforcement.
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      hooks: { PreToolUse: [{ hooks: [confineToRepoRoot] }] },
      settingSources: [],
      // A gateway model can run a long stretch with zero top-level messages
      // before the first one arrives; partials keep the stream observably
      // alive in the meantime (mirrors adapters/claude-sdk's acp-host.ts,
      // which depends on this for the same reason).
      includePartialMessages: true,
      // `tools` restricts the base toolset available at all — Read/Grep/Glob
      // always, Edit only outside --dry-run. The PreToolUse hook above then
      // confines every call within that set to ROOT.
      tools: DRY_RUN ? ['Read', 'Grep', 'Glob'] : ['Read', 'Grep', 'Glob', 'Edit'],
      // 40 wasn't enough for an unusually large batch (15 packages in one
      // release commit, observed live) — the run hit the cap mid-audit.
      // Raised as headroom, not a guarantee: an even larger batch can still
      // hit it, which is why hitting the cap is handled as a soft failure
      // below rather than crashing.
      maxTurns: 80,
    },
  })

  let finalResult = null
  try {
    for await (const message of result) {
      if (message.type === 'stream_event') {
        process.stdout.write('.')
      } else if (message.type === 'assistant') {
        for (const block of message.message.content ?? []) {
          if (block.type === 'text' && block.text) console.log('\n' + block.text)
          if (block.type === 'tool_use') {
            const input = Object.entries(block.input ?? {})
              .map(([k, v]) => `${k}=${JSON.stringify(v).slice(0, 80)}`)
              .join(', ')
            console.log(`   🔧 ${block.name}(${input})`)
          }
        }
      } else if (message.type === 'user') {
        // Surfaces PreToolUse denials (e.g. the path-confinement guard) in the
        // CI log — otherwise a denied call is silent apart from the model's
        // own retry.
        for (const block of message.message.content ?? []) {
          if (block.type === 'tool_result' && block.is_error) {
            const text = Array.isArray(block.content) ? block.content.map((c) => c.text).join('') : block.content
            console.log(`   ⛔ ${String(text).slice(0, 300)}`)
          }
        }
      } else if (message.type === 'result') {
        finalResult = message
      }
    }
  } catch (e) {
    // The SDK throws (rather than yielding a `result` message) on some
    // terminal conditions — e.g. `error_max_turns`, observed live on an
    // unusually large batch (15 packages in one release commit). This is a
    // soft failure, not a hard one: docs-check is a best-effort bonus on top
    // of an already-published release, and must never make the release job
    // itself look red. Whatever edits were already applied before the cutoff
    // are still on disk — the workflow's drift-detection step still picks
    // them up and opens a PR (partial coverage, flagged by this message in
    // the log, is preferable to no PR at all).
    console.warn(`\n⚠️  docs-check did not finish cleanly: ${e.message}`)
    console.warn('Any edits made before the cutoff are still on disk; the workflow will PR them if present.')
    emitStatus('error')
    return
  }

  if (!finalResult) {
    console.warn('\n⚠️  docs-check produced no result message (stream ended without one).')
    emitStatus('no-result')
    return
  }
  if (finalResult.is_error) {
    console.warn(`\n⚠️  docs-check ended with an error (stop_reason: ${finalResult.stop_reason}): ${finalResult.result}`)
    emitStatus('error')
    return
  }

  const cost = typeof finalResult.total_cost_usd === 'number' ? `, $${finalResult.total_cost_usd.toFixed(4)}` : ''
  console.log(`\n✅ docs-check complete (${finalResult.num_turns} turns${cost}).`)
  emitStatus('ok')
}

await main()

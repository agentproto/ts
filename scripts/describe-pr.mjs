#!/usr/bin/env node
/**
 * agentflow describe — fill a PR's description from its diff.
 *
 * A `review`-flavored read-only step: it reads the branch diff + commit subjects
 * and writes a "what / why / changes" body via `gh pr edit`. It only fills an
 * EMPTY/thin body (never clobbers a human- or agent-written description) unless
 * `--force`. Engine-routed via the shared llm.mjs (cloud in CI).
 *
 *   node scripts/describe-pr.mjs --pr <n> [--force]
 *
 * Env: GH_TOKEN (post), ANTHROPIC_API_KEY (cloud engine). PR_NUMBER as fallback.
 */

import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { runLlm, stripFences } from './agentflow/llm.mjs'

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const run = (c) => execSync(c, { cwd: ROOT, encoding: 'utf8' }).trim()
const argv = process.argv.slice(2)
const flag = (n) => {
  const i = argv.indexOf(n)
  return i !== -1 ? argv[i + 1] : undefined
}
const FORCE = argv.includes('--force')
const PR = flag('--pr') ?? process.env.PR_NUMBER
if (!PR) {
  console.error('Usage: describe-pr.mjs --pr <n> [--force]')
  process.exit(1)
}

function cfg() {
  try {
    return JSON.parse(readFileSync(`${ROOT}/.github/agentic-review.json`, 'utf8')).describe ?? {}
  } catch {
    return {}
  }
}
const MIN = Number(cfg().minBodyChars ?? 80)

// Respect an existing body — only fill when it's empty/thin (unless --force).
const currentBody = run(`gh pr view "${PR}" --json body -q '.body'`)
if (!FORCE && currentBody && currentBody.replace(/\s/g, '').length >= MIN) {
  console.log(`[describe] PR #${PR} already has a body (${currentBody.length} chars) — leaving it. Use --force to overwrite.`)
  process.exit(0)
}

const changedFiles = run('git diff --name-only origin/main...HEAD')
if (!changedFiles) {
  console.log('[describe] no diff vs origin/main — nothing to describe.')
  process.exit(0)
}
const commits = run('git log --format=%s origin/main..HEAD').slice(0, 4_000)
const diff = run('git diff origin/main...HEAD').slice(0, 16_000)

const system = `You write concise, accurate pull-request descriptions for the @agentproto/ts monorepo.
Given the diff + commit subjects, produce GitHub-flavored markdown with exactly these sections:

## What
1-3 sentences: what this PR does.

## Why
1-2 sentences: the motivation / problem it solves (infer from the diff; omit if truly unclear).

## Changes
- terse bullets of the notable changes (by area/file)

Be factual — describe only what the diff shows. No filler, no "this PR aims to". Reply with ONLY the markdown body (no fences, no preamble).`
const user = `Commit subjects:\n${commits}\n\nChanged files:\n${changedFiles}\n\nDiff (may be truncated):\n${diff}`

let body
try {
  body = stripFences(await runLlm({ system, user, engine: 'cloud' }))
} catch (err) {
  console.error('[describe] generation failed —', err.message)
  process.exit(0) // non-fatal: a missing description should never fail CI
}

const marker = '\n\n<sub>📝 description drafted by agentflow — edit freely.</sub>'
run(`gh pr edit "${PR}" --body ${JSON.stringify(body + marker)}`)
console.log(`[describe] set description on PR #${PR} (${body.length} chars).`)

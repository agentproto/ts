#!/usr/bin/env node
/**
 * agentflow local review — a fast, engine-routed sanity review of the
 * current branch vs origin/main, meant to run before you push.
 *
 *   node scripts/agentflow/review.mjs            # engine from config
 *   node scripts/agentflow/review.mjs --engine cloud
 *   node scripts/agentflow/review.mjs --stamp    # also write the CI-bypass marker
 *
 * This is the lightweight sibling of the CI reviewer (scripts/review-pr.mjs,
 * which is a full agentic tool-loop). Here we do a single-shot diff review
 * via the shared engine router, so it runs locally on the Claude Code CLI
 * (subscription, no API key) — or `cloud` for the API.
 *
 * Exit code: 0 on approve (or non-blocking), 1 when the review requests
 * changes and review.blocking is true.
 *
 * Bypass: with --stamp (or review.bypassCi=true) an *approving* review writes
 * an empty marker commit `[agentflow-reviewed]`, which the CI reviewer detects
 * and skips — trading the cloud re-review for speed. Default OFF; the local
 * single-shot pass is lighter than CI's agentic review, so only opt in when
 * you trust it for a given branch.
 */

import { execSync } from 'node:child_process'
import { resolve } from 'node:path'
import { loadAgentflowConfig, resolveEngine } from './config.mjs'
import { runLlm, stripFences } from './llm.mjs'

const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '')
const AGENTFLOW = loadAgentflowConfig(ROOT)
const argv = process.argv.slice(2)
const ENGINE_FLAG = (() => {
  const i = argv.indexOf('--engine')
  return i !== -1 ? argv[i + 1] : undefined
})()
// `--hook` is set when invoked from the pre-push/pre-commit dispatcher.
const FROM_HOOK = argv.includes('--hook')
// Stamping during a PRE-PUSH hook is futile: a commit created in pre-push is
// NOT part of the in-flight push (the refs to push are already computed), so
// the marker never reaches the remote. So only stamp on an explicit --stamp,
// or on a non-hook `bypassCi` run — in both cases the dev pushes the marker
// commit themselves afterwards.
const STAMP = argv.includes('--stamp') || (AGENTFLOW.review.bypassCi === true && !FROM_HOOK)

function run(cmd) {
  return execSync(cmd, { cwd: ROOT, encoding: 'utf8' }).trim()
}

// ── gather the diff ──────────────────────────────────────────────────────────

let changedFiles = ''
try {
  changedFiles = run('git diff --name-only origin/main...HEAD')
} catch {
  console.error('[agentflow] review: cannot diff against origin/main (fetch it first?).')
  process.exit(0) // non-fatal for a hook
}
if (!changedFiles) {
  console.log('[agentflow] review: no changes vs origin/main — nothing to review.')
  process.exit(0)
}

// Three-dot (merge-base) for the diff: review what the branch *introduces*,
// independent of how far main has moved. (CI's bypass marker check uses
// two-dot `origin/main..HEAD` — it scans the branch's commit range for the
// marker, a different question, so the asymmetry is intentional.)
const DIFF_CAP = 16_000
const fullDiff = run('git diff origin/main...HEAD')
const truncated = fullDiff.length > DIFF_CAP
const rawDiff = fullDiff.slice(0, DIFF_CAP)
if (truncated) {
  console.warn(
    `[agentflow] review: diff is ${fullDiff.length} chars — reviewing the first ${DIFF_CAP} only (partial).`,
  )
}

// ── review (engine-routed) ────────────────────────────────────────────────────

const engine = resolveEngine(AGENTFLOW.review, { flag: ENGINE_FLAG })

const systemPrompt = `You are a senior code reviewer for the @agentproto/ts monorepo.
Review the diff for correctness bugs and obvious simplifications. Be terse and
high-signal: only flag things that matter. Do NOT nitpick style.

Reply ONLY with valid JSON — no markdown fences, no prose:
{
  "decision": "approve" | "request_changes",
  "summary": "one-line verdict",
  "findings": [{ "severity": "high|medium|low", "file": "path", "note": "what + why" }]
}

Use "request_changes" only for real correctness problems (bugs, broken contracts,
security). Simplifications are "low" findings under an "approve".`

const userPrompt = `Changed files:\n${changedFiles}\n\nDiff (may be truncated):\n${rawDiff}`

console.log(`[agentflow] reviewing ${changedFiles.split('\n').length} file(s) vs origin/main (engine: ${engine})…`)

let raw
try {
  raw = await runLlm({
    system: systemPrompt,
    user: userPrompt,
    engine,
    model: AGENTFLOW.review.model ?? undefined,
    claudeBin: AGENTFLOW.review.command ?? 'claude',
  })
} catch (err) {
  console.error(err.message)
  process.exit(0) // a flaky review must not wedge a push
}

let verdict
try {
  verdict = JSON.parse(stripFences(raw))
} catch {
  console.error('[agentflow] review: could not parse model output as JSON:\n', raw)
  process.exit(0)
}

// ── report ────────────────────────────────────────────────────────────────────

const findings = Array.isArray(verdict.findings) ? verdict.findings : []
console.log(`\n  ${verdict.decision === 'approve' ? '✓ APPROVE' : '✗ REQUEST CHANGES'} — ${verdict.summary ?? ''}`)
for (const f of findings) {
  console.log(`    [${f.severity ?? '?'}] ${f.file ?? ''}: ${f.note ?? ''}`)
}
console.log('')

// ── CI-bypass marker ──────────────────────────────────────────────────────────

if (STAMP && verdict.decision === 'approve') {
  if (truncated) {
    console.warn('[agentflow] note: bypass marker is based on a PARTIAL (truncated) review.')
  }
  const head = run('git rev-parse --short HEAD')
  run(
    `git commit --allow-empty -m ${JSON.stringify(
      `chore(agentflow): local review passed [agentflow-reviewed] @ ${head}`,
    )}`,
  )
  console.log('[agentflow] wrote CI-bypass marker commit ([agentflow-reviewed]).')
} else if (FROM_HOOK && AGENTFLOW.review.bypassCi === true && verdict.decision === 'approve') {
  // bypassCi is on, but git hooks can't add a marker commit to a push (and
  // shouldn't create one mid-commit), so the marker must be made explicitly.
  console.log(
    '[agentflow] bypassCi is on, but hooks can\'t stamp the marker — run `pnpm review:ai --stamp` before pushing to skip the cloud reviewer.',
  )
}

if (verdict.decision === 'request_changes' && AGENTFLOW.review.blocking === true) {
  process.exit(1)
}
process.exit(0)

#!/usr/bin/env node
/**
 * agentflow review loop — review → fix → re-review until approve or maxLoops.
 *
 * Composes the two primitives:
 *   review (fresh judge)  ·  code (the fixer, carrying a Claude session)
 *
 * The fixer resumes ONE session across rounds, so it remembers the timeline of
 * its own changes. The re-review is fresh each round but fed the prior findings
 * as DATA, so it judges independently (won't rubber-stamp the fixer's work).
 *
 *   node scripts/agentflow/loop.mjs [--engine local|cloud] [--max N]
 *   pnpm review:loop
 *
 * Edits land in the working tree (uncommitted) — review the diff and commit.
 */

import { randomUUID } from 'node:crypto'
import { execSync as sh } from 'node:child_process'
import { loadAgentflowConfig, resolveEngine } from './config.mjs'
import { gatherDiff, reviewDiff } from './primitives/review.mjs'
import { runCode } from './primitives/code.mjs'

const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '')
const cfg = loadAgentflowConfig(ROOT)
const argv = process.argv.slice(2)
const flag = (name) => {
  const i = argv.indexOf(name)
  return i !== -1 ? argv[i + 1] : undefined
}

const engine = resolveEngine(cfg.review, { flag: flag('--engine') })
const maxParsed = Number(flag('--max'))
const maxLoops = Number.isFinite(maxParsed) && maxParsed > 0 ? maxParsed : (cfg.review.maxLoops ?? 3)
const model = cfg.review.model ?? undefined
const claudeBin = cfg.review.command ?? 'claude'

if (engine !== 'local') {
  console.error('[agentflow] loop: the fixer needs the local Claude CLI — set engine "local".')
  process.exit(1)
}

const sessionId = randomUUID()
let priorFindings = null
let resume = false
let round = 0
let approved = false

while (round < maxLoops) {
  round++
  let diffInfo
  try {
    diffInfo = gatherDiff(ROOT)
  } catch (err) {
    console.error('[agentflow] loop: cannot diff against origin/main (fetch it first?) —', err.message)
    process.exit(1)
  }
  const { changedFiles, fileCount, diff, truncated } = diffInfo
  if (!changedFiles) {
    console.log('[agentflow] loop: nothing to review vs origin/main.')
    approved = true
    break
  }
  if (truncated) console.warn('[agentflow] loop: diff truncated — partial review.')
  console.log(`\n[agentflow] ── round ${round}/${maxLoops}: reviewing ${fileCount} file(s) (engine: ${engine}) ──`)

  let verdict
  try {
    verdict = await reviewDiff({ changedFiles, diff, priorFindings, engine, model, claudeBin })
  } catch (err) {
    console.error('[agentflow] loop: review failed —', err.message)
    process.exit(1)
  }
  console.log(`  ${verdict.decision === 'approve' ? '✓ APPROVE' : '✗ REQUEST CHANGES'} — ${verdict.summary ?? ''}`)
  for (const f of verdict.findings) console.log(`    [${f.severity ?? '?'}] ${f.file ?? ''}: ${f.note ?? ''}`)

  // `decision` is authoritative — never infer approval from empty findings.
  if (verdict.decision === 'approve') {
    approved = true
    break
  }
  if (verdict.findings.length === 0) {
    console.warn('[agentflow] loop: request_changes with no actionable findings — stopping.')
    break
  }
  if (round === maxLoops) break

  const goal =
    'Apply minimal edits to fix ONLY these review findings. Do not reformat ' +
    'unrelated code and do not create commits.\n\n' +
    verdict.findings.map((f, i) => `${i + 1}. [${f.severity ?? '?'}] ${f.file ?? ''}: ${f.note ?? ''}`).join('\n')
  console.log(`\n[agentflow] ── round ${round}: applying fixes (session ${resume ? 'resumed' : sessionId.slice(0, 8)}) ──`)
  const { ok } = runCode({ goal, sessionId, resume, engine, claudeBin, model, root: ROOT })
  resume = true
  priorFindings = verdict.findings
  if (!ok) {
    console.error('[agentflow] loop: fixer exited non-zero — stopping. Inspect the working tree.')
    break
  }
}

console.log('')
console.log(
  approved
    ? '[agentflow] ✓ loop complete — approved.'
    : `[agentflow] ⚠ loop hit max (${maxLoops}) with changes still requested — inspect the working tree.`,
)
try {
  console.log(sh('git diff --stat', { cwd: ROOT, encoding: 'utf8' }))
} catch {
  /* noop */
}
process.exit(approved ? 0 : 1)

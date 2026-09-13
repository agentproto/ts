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
 *   node scripts/agentflow/loop.mjs [--engine local|daemon] [--max N]
 *   pnpm review:loop
 *
 * Edits land in the working tree (uncommitted) — review the diff and commit.
 */

import { randomUUID } from 'node:crypto'
import { execSync as sh } from 'node:child_process'
import { loadAgentflowConfig, resolveEngine } from './config.mjs'
import { gatherDiff, reviewDiff, reviewViaDaemon } from './primitives/review.mjs'
import { runCode } from './primitives/code.mjs'
import { connectDaemon, readDaemonToken } from '../lib/daemon-mcp.mjs'

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

// The fixer (`code` primitive) always needs the local Claude CLI's edit
// tools — that's not engine-configurable. The JUDGE, however, can be
// "local"/"cloud" (single-shot) or "daemon" (the full pr-review workflow via
// the local agentproto daemon) — see the review call below.
if (engine !== 'local' && engine !== 'daemon') {
  console.error(
    '[agentflow] loop: engine must be "local" or "daemon" (the fixer itself always runs the local Claude CLI).',
  )
  process.exit(1)
}

// engine "daemon": connect once, up front, so an unreachable daemon fails
// fast with one clear message instead of once per round.
let daemonClient
if (engine === 'daemon') {
  const port = cfg.review.daemonPort ?? 18790
  try {
    daemonClient = await connectDaemon({ port, token: readDaemonToken({ port }) })
  } catch (err) {
    console.error(`[agentflow] loop: daemon unreachable on port ${port} (${err.message}).`)
    console.error('  Start it with `agentproto serve`, or run with `--engine local`.')
    process.exit(1)
  }
}
const daemonPort = cfg.review.daemonPort ?? 18790
const daemonTimeoutMs = (cfg.review.daemonTimeoutMinutes ?? 15) * 60_000

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
    if (engine === 'daemon') {
      // The pr-review workflow's "local" placement has no priorFindings
      // input — each round re-reviews the branch fresh (still independent,
      // just not incremental the way the single-shot judge can be).
      if (priorFindings) {
        console.log('[agentflow] loop: engine "daemon" re-reviews fresh each round (no prior-findings input).')
      }
      const pollStart = Date.now()
      verdict = await reviewViaDaemon({
        root: ROOT,
        baseRef: 'main',
        port: daemonPort,
        timeoutMs: daemonTimeoutMs,
        adapter: cfg.review.adapter ?? undefined,
        client: daemonClient,
        onStatus: (run, runId) => {
          const secs = Math.round((Date.now() - pollStart) / 1000)
          console.log(`[agentflow] daemon run ${runId} … status=${run.status} (${secs}s)`)
        },
      })
    } else {
      verdict = await reviewDiff({ changedFiles, diff, priorFindings, engine, model, claudeBin })
    }
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
  // The fixer always runs the local Claude CLI (code.mjs#runCode only
  // supports engine "local"), regardless of which engine judged the review.
  const { ok } = runCode({ goal, sessionId, resume, engine: 'local', claudeBin, model, root: ROOT })
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

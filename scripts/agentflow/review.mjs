#!/usr/bin/env node
/**
 * agentflow local review — a fast, engine-routed sanity review of the
 * current branch vs origin/main, meant to run before you push.
 *
 *   node scripts/agentflow/review.mjs            # engine from config
 *   node scripts/agentflow/review.mjs --engine cloud
 *   node scripts/agentflow/review.mjs --engine daemon  # full agentic review via the local daemon
 *   node scripts/agentflow/review.mjs --stamp    # also write the CI-bypass marker
 *
 * `local` / `cloud` do a single-shot diff review via the shared engine router
 * (scripts/agentflow/primitives/review.mjs#reviewDiff) — the lightweight
 * sibling of the CI reviewer. `daemon` instead runs the SAME agentic review
 * CI runs (.github/agentproto-workflows/pr-review/WORKFLOW.md, placement:
 * "local") through your already-running `agentproto serve` daemon over MCP —
 * full tool access, no diff cap; needs `agentproto serve` running locally.
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
import { openSync, readSync, closeSync } from 'node:fs'
import { loadAgentflowConfig, resolveEngine } from './config.mjs'
import { gatherChangedFiles, gatherDiff, reviewDiff, reviewViaDaemon, DIFF_CAP } from './primitives/review.mjs'
import { runCode } from './primitives/code.mjs'
import { connectDaemon, readDaemonToken } from '../lib/daemon-mcp.mjs'

const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '')
const AGENTFLOW = loadAgentflowConfig(ROOT)
const argv = process.argv.slice(2)
const ENGINE_FLAG = (() => {
  const i = argv.indexOf('--engine')
  return i !== -1 ? argv[i + 1] : undefined
})()
// `--hook` is set when invoked from the pre-push/pre-commit dispatcher.
const FROM_HOOK = argv.includes('--hook')
// Fix mode: --fix → interactive y/n; --fix-auto → apply without asking; else
// fall back to config (review.fix: off|prompt|auto). Applying fixes is a
// MANUAL flow only — never from a hook (a hook can't usefully edit a push).
const FIX_MODE = argv.includes('--fix-auto')
  ? 'auto'
  : argv.includes('--fix')
    ? 'prompt'
    : (AGENTFLOW.review.fix ?? 'off')
// Stamping during a PRE-PUSH hook is futile: a commit created in pre-push is
// NOT part of the in-flight push (the refs to push are already computed), so
// the marker never reaches the remote. So only stamp on an explicit --stamp,
// or on a non-hook `bypassCi` run — in both cases the dev pushes the marker
// commit themselves afterwards.
const STAMP = argv.includes('--stamp') || (AGENTFLOW.review.bypassCi === true && !FROM_HOOK)

function run(cmd) {
  return execSync(cmd, { cwd: ROOT, encoding: 'utf8' }).trim()
}

// ── gather + review (via primitives) ───────────────────────────────────────────

const engine = resolveEngine(AGENTFLOW.review, { flag: ENGINE_FLAG })

// engine "daemon" never needs the full diff body — the agent reads the live
// checkout itself over the daemon's own tools — so skip the (possibly
// hundreds-of-MB) `git diff` read entirely for that engine.
let changedFiles, fileCount, rawDiff, truncated
try {
  if (engine === 'daemon') {
    ;({ changedFiles, fileCount } = gatherChangedFiles(ROOT))
    rawDiff = ''
    truncated = false
  } else {
    ;({ changedFiles, fileCount, diff: rawDiff, truncated } = gatherDiff(ROOT))
  }
} catch {
  console.error('[agentflow] review: cannot diff against origin/main (fetch it first?).')
  process.exit(0) // non-fatal for a hook
}
if (!changedFiles) {
  console.log('[agentflow] review: no changes vs origin/main — nothing to review.')
  process.exit(0)
}
if (truncated) {
  console.warn(`[agentflow] review: diff truncated — reviewing the first ${DIFF_CAP} chars (partial).`)
}

// The local Claude Code CLI is memory-heavy to spawn inside a git hook. For
// non-trivial branches, the child process can be OOM-killed and take the push
// down with it (exit 137). Skip the local-CLI review from hooks when the diff
// is large; the developer can still run `pnpm review:ai` manually or rely on
// CI. Exits 0 so the push is not blocked.
const HOOK_LOCAL_FILE_LIMIT = Math.max(
  1,
  Number.parseInt(process.env.AGENTFLOW_HOOK_LOCAL_FILE_LIMIT ?? '3', 10) || 3,
)
const HOOK_LOCAL_DIFF_LIMIT = Math.max(
  1,
  Number.parseInt(process.env.AGENTFLOW_HOOK_LOCAL_DIFF_LIMIT ?? '8000', 10) || 8000,
)
if (
  FROM_HOOK &&
  engine === 'local' &&
  (fileCount > HOOK_LOCAL_FILE_LIMIT || rawDiff.length > HOOK_LOCAL_DIFF_LIMIT)
) {
  console.warn(
    `[agentflow] review: branch is too large for a local pre-push review ` +
      `(${fileCount} files, ${rawDiff.length} chars). ` +
      `Run \`pnpm review:ai\` manually, or push to rely on CI.`,
  )
  process.exit(0)
}

console.log(`[agentflow] reviewing ${fileCount} file(s) vs origin/main (engine: ${engine})…`)

let verdict
if (engine === 'daemon') {
  const port = AGENTFLOW.review.daemonPort ?? 18790
  // Connect BEFORE calling reviewViaDaemon so an unreachable daemon (no
  // metadata file, connection refused) gets its own single clear warning
  // instead of being indistinguishable from "the review itself failed." A
  // weaker review pretending to be the full one is worse than an honest
  // skip, so this never falls back to a single-shot review.
  let daemonClient
  try {
    const token = readDaemonToken({ port })
    daemonClient = await connectDaemon({ port, token })
  } catch (err) {
    console.error(`[agentflow] review: daemon unreachable on port ${port} (${err.message}).`)
    if (FROM_HOOK) process.exit(0) // non-blocking, same policy as a flaky review
    console.error('  Start it with `agentproto serve`, or run with `--engine local`.')
    process.exit(1)
  }
  const timeoutMs = (AGENTFLOW.review.daemonTimeoutMinutes ?? 15) * 60_000
  const pollStart = Date.now()
  try {
    verdict = await reviewViaDaemon({
      root: ROOT,
      baseRef: 'main',
      port,
      timeoutMs,
      adapter: AGENTFLOW.review.adapter ?? undefined,
      client: daemonClient,
      onStatus: (run, runId) => {
        const secs = Math.round((Date.now() - pollStart) / 1000)
        console.log(`[agentflow] daemon run ${runId} … status=${run.status} (${secs}s)`)
      },
    })
  } catch (err) {
    console.error('[agentflow] review:', err.message)
    process.exit(0) // a flaky review must not wedge a push
  }
} else {
  try {
    verdict = await reviewDiff({
      changedFiles,
      diff: rawDiff,
      engine,
      model: AGENTFLOW.review.model ?? undefined,
      claudeBin: AGENTFLOW.review.command ?? 'claude',
    })
  } catch (err) {
    console.error('[agentflow] review:', err.message)
    process.exit(0) // a flaky review must not wedge a push
  }
}

// ── report ────────────────────────────────────────────────────────────────────

const findings = verdict.findings
console.log(`\n  ${verdict.decision === 'approve' ? '✓ APPROVE' : '✗ REQUEST CHANGES'} — ${verdict.summary ?? ''}`)
for (const f of findings) {
  console.log(`    [${f.severity ?? '?'}] ${f.file ?? ''}: ${f.note ?? ''}`)
}
console.log('')

// ── propose / apply fixes (manual flow only) ───────────────────────────────────

/** Read y/n from the terminal directly, so it works even when stdin is busy. */
function promptYesNo(question) {
  let fd
  try {
    fd = openSync('/dev/tty', 'rs')
  } catch {
    return false // no terminal (CI / piped) — treat as "no"
  }
  try {
    process.stdout.write(question)
    const buf = Buffer.alloc(16)
    const n = readSync(fd, buf, 0, 16, null)
    const ans = buf.toString('utf8', 0, n).trim().toLowerCase()
    return ans === 'y' || ans === 'yes'
  } catch {
    return false
  } finally {
    closeSync(fd)
  }
}

/** Apply the findings via the `code` primitive (local Claude CLI edits). */
function applyFixes(items) {
  const instructions = items
    .map((f, i) => `${i + 1}. [${f.severity ?? '?'}] ${f.file ?? ''}: ${f.note ?? ''}`)
    .join('\n')
  const goal =
    `Apply minimal edits to this repository to fix ONLY the code-review findings ` +
    `below. Do not reformat unrelated code and do not create commits.\n\nFindings:\n${instructions}`
  console.log('[agentflow] applying fixes with the local Claude CLI…\n')
  const { ok } = runCode({
    goal,
    engine,
    claudeBin: AGENTFLOW.review.command ?? 'claude',
    model: AGENTFLOW.review.model ?? undefined,
    root: ROOT,
  })
  if (!ok) {
    console.error('[agentflow] fixer exited non-zero — inspect the working tree.')
    return false
  }
  console.log('\n[agentflow] fixes applied (uncommitted). Review and commit:')
  console.log(run('git diff --stat'))
  return true
}

let fixed = false
if (findings.length > 0 && FIX_MODE !== 'off') {
  if (FROM_HOOK) {
    // Hooks can't usefully edit a push (and shouldn't prompt). Point to the
    // manual flow instead.
    console.log('[agentflow] to apply these, run: `pnpm review:ai --fix`')
  } else if (engine !== 'local') {
    console.log('[agentflow] auto-fix runs on the local Claude CLI — set engine "local" (or use CI `/fix`).')
  } else {
    const go =
      FIX_MODE === 'auto' ||
      promptYesNo(`Apply ${findings.length} fix(es) with the local Claude CLI? [y/N] `)
    if (go) fixed = applyFixes(findings)
    else console.log('[agentflow] skipped fixes.')
  }
}

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

if (verdict.decision === 'request_changes' && AGENTFLOW.review.blocking === true && !fixed) {
  console.error(
    `\n[agentflow] ✗ ${FROM_HOOK ? 'push blocked' : 'review requested changes'} — review.blocking is on.`,
  )
  console.error('  Fix now:   `pnpm review:ai --fix`')
  if (FROM_HOOK) console.error('  Skip once: `git push --no-verify`')
  process.exit(1)
}
process.exit(0)

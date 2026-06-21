#!/usr/bin/env node
/**
 * agentflow git-hook dispatcher.
 *
 *   node scripts/agentflow/hook.mjs <commit|push>
 *
 * Husky calls this from `.husky/pre-commit` (commit) and `.husky/pre-push`
 * (push). For each feature whose configured `stage` matches the trigger, it
 * runs that feature's engine. Features at stage "manual" never fire here —
 * they're run on demand via `pnpm changeset:ai` / `pnpm review:ai`.
 *
 * Non-blocking by design: a feature failure logs a warning and the hook
 * still exits 0, so a flaky AI call never wedges your commit/push. (Tighten
 * later per-feature if you want hard gating.)
 */

import { spawnSync } from 'node:child_process'
import { loadAgentflowConfig } from './config.mjs'

const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '')
const trigger = process.argv[2] // "commit" | "push"

if (trigger !== 'commit' && trigger !== 'push') {
  console.error(`[agentflow] hook: unknown trigger "${trigger}" (want commit|push)`)
  process.exit(0)
}

const cfg = loadAgentflowConfig(ROOT)

function runNode(args, label) {
  console.log(`[agentflow] ${label}…`)
  const res = spawnSync('node', args, { cwd: ROOT, stdio: 'inherit' })
  if (res.status !== 0) {
    console.warn(`[agentflow] ${label} did not complete (exit ${res.status}) — continuing.`)
  }
  return res.status === 0
}

// ── changeset ──────────────────────────────────────────────────────────────
if (cfg.changeset?.stage === trigger) {
  runNode(['scripts/auto-changeset.mjs'], 'AI changeset')
  // Did auto-changeset leave a new, uncommitted changeset? (It exits 0 both
  // when it writes one and when none is needed, so check the tree.)
  const pending = spawnSync('git', ['status', '--porcelain', '.changeset'], {
    cwd: ROOT,
    encoding: 'utf8',
  }).stdout.trim()
  if (pending) {
    if (trigger === 'commit') {
      // pre-commit: fold it into THIS commit.
      spawnSync('git', ['add', '.changeset'], { cwd: ROOT, stdio: 'inherit' })
    } else if (trigger === 'push') {
      // pre-push CAN'T add to the in-flight push (refs are already computed),
      // so commit the changeset and HOLD the push — the next push includes it.
      spawnSync('git', ['add', '.changeset'], { cwd: ROOT, stdio: 'inherit' })
      spawnSync('git', ['commit', '-m', 'chore: add changeset'], { cwd: ROOT, stdio: 'inherit' })
      console.error('\n[agentflow] ✗ push held — added a changeset commit. Run `git push` again to include it.')
      process.exit(1)
    }
  }
}

// ── review ───────────────────────────────────────────────────────────────────
if (cfg.review?.stage === trigger) {
  // review.mjs self-handles the CI-bypass marker when review.bypassCi is set.
  // It exits non-zero only when blocking + request_changes; surface that so a
  // blocking review can stop a push.
  const ok = runNode(['scripts/agentflow/review.mjs', '--hook'], 'AI review')
  if (!ok && cfg.review.blocking === true) {
    console.error('[agentflow] blocking review requested changes — aborting.')
    process.exit(1)
  }
}

process.exit(0)

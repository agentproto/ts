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
  const wrote = runNode(['scripts/auto-changeset.mjs'], 'AI changeset')
  // On pre-commit, fold a freshly written changeset into THIS commit so it
  // isn't left dangling as an untracked file.
  if (wrote && trigger === 'commit') {
    spawnSync('git', ['add', '.changeset'], { cwd: ROOT, stdio: 'inherit' })
  }
}

// ── review (wired in Task 2) ─────────────────────────────────────────────────
if (cfg.review?.stage === trigger) {
  console.log('[agentflow] local review is not wired yet (Task 2) — skipping.')
}

process.exit(0)

#!/usr/bin/env node
/**
 * agentflow maintainer — the merge gatekeeper.
 *
 * A `review`-flavored JUDGE whose verdict is a merge decision (not code
 * findings): given an already-APPROVED PR, decide whether it's safe to
 * auto-merge or should be handed to a human. Conservative by design — when in
 * doubt, escalate.
 *
 * Two layers:
 *   1. Deterministic guardrail — any changed file matching
 *      merge.alwaysEscalateGlobs forces escalate (no LLM judgment overrides it).
 *   2. LLM judgment (cloud engine) — weighs criticality for everything else.
 *
 * Prints ONE JSON object to stdout: { decision, criticality, reason }.
 * Logs go to stderr so the caller can capture the verdict cleanly.
 *
 *   node scripts/maintainer.mjs
 */

import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { runLlm, parseJsonLoose } from './agentflow/llm.mjs'

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const run = (c) => execSync(c, { cwd: ROOT, encoding: 'utf8' }).trim()

/**
 * Merge policy — read from AGENTFLOW_POLICY_FILE when set.
 *
 * The workflow pins that to the *base branch's* copy of agentic-review.json.
 * Falling back to the in-tree copy means reading the PR's own file, which is a
 * PR grading its own homework: `alwaysEscalateGlobs` is the deterministic
 * guardrail below, and a PR could simply empty it. The env var is the
 * trustworthy path; the fallback is for running this script by hand.
 */
function mergeCfg() {
  const pinned = process.env.AGENTFLOW_POLICY_FILE
  try {
    return JSON.parse(readFileSync(pinned || `${ROOT}/.github/agentic-review.json`, 'utf8')).merge ?? {}
  } catch {
    return {}
  }
}

function emit(decision, criticality, reason) {
  console.error(`[maintainer] ${decision} (${criticality}) — ${reason}`)
  console.log(JSON.stringify({ decision, criticality, reason }))
}

/** Minimal glob: `**` → any, `*` → any non-slash. */
function matchGlob(file, glob) {
  const re = new RegExp(
    '^' +
      glob
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*/g, 'GLOBSTAR_SENTINEL')
        .replace(/\*/g, '[^/]*')
        .replace(/GLOBSTAR_SENTINEL/g, '.*') +
      '$',
  )
  return re.test(file)
}

const cfg = mergeCfg()
const escalateGlobs = Array.isArray(cfg.alwaysEscalateGlobs) ? cfg.alwaysEscalateGlobs : []

// origin/main is provided by the agent-setup harness; fetch defensively anyway,
// and if the diff still can't be computed, fail SAFE with a valid escalate
// verdict rather than crashing into "maintainer output unreadable".
try {
  execSync('git fetch --quiet origin main', { cwd: ROOT, stdio: 'ignore' })
} catch {
  /* best-effort */
}

let changedFiles
try {
  changedFiles = run('git diff --name-only origin/main...HEAD').split('\n').filter(Boolean)
} catch (err) {
  emit('escalate', 'high', `could not diff against origin/main: ${err.message.split('\n')[0]}`)
  process.exit(0)
}

// ── 1. deterministic guardrail ────────────────────────────────────────────────
const hit = changedFiles.find((f) => escalateGlobs.some((g) => matchGlob(f, g)))
if (hit) {
  emit('escalate', 'high', `changed file '${hit}' matches an always-escalate path`)
  process.exit(0)
}

// ── 2. LLM judgment (cloud) ────────────────────────────────────────────────────
let diff = ''
try {
  diff = run('git diff origin/main...HEAD').slice(0, 16_000)
} catch {
  /* fall back to judging on the file list alone */
}
const system = `You are the MAINTAINER of the @agentproto/ts monorepo, deciding whether an
already-APPROVED pull request can be auto-merged or must be handed to a human.
Default to CAUTION — escalate anything risky or ambiguous.

Reply ONLY with valid JSON, no fences:
{ "decision": "merge" | "escalate", "criticality": "low" | "medium" | "high", "reason": "one terse line" }

Escalate (decision="escalate") when the change touches any of: security / auth,
secrets or credentials, data migrations or schema, public API or breaking
changes, release / publish / CI infrastructure, money or billing — or when the
diff is large, broad, or you are uncertain. Choose "merge" ONLY for changes that
are clearly safe and well-scoped (docs, tests, small internal fixes).`
const user = `Changed files:\n${changedFiles.join('\n') || '(none)'}\n\nDiff (may be truncated):\n${diff}`

try {
  const raw = await runLlm({ system, user, engine: 'cloud' })
  const v = parseJsonLoose(raw)
  emit(v.decision === 'merge' ? 'merge' : 'escalate', v.criticality ?? 'medium', v.reason ?? '(no reason)')
} catch (err) {
  // A failed judge must never silently auto-merge — fail safe to escalate.
  emit('escalate', 'high', `maintainer judge failed (${err.message}) — escalating to be safe`)
}

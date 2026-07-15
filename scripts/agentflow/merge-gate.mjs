#!/usr/bin/env node
/**
 * agentflow merge-gate — the deterministic half of the auto-merge decision.
 *
 * `decideMergeGate(input)` is a pure function: no I/O, no LLM call, every
 * input passed in — so the full lattice is table-testable (see
 * merge-gate.test.mjs). The CLI wrapper below gathers live PR/repo state and
 * prints the verdict as one JSON line to stdout, mirroring
 * scripts/maintainer.mjs's shape. ci.yml is a thin caller: it must never
 * re-implement this decision inline in bash again.
 *
 * This mirrors the exact decision rules landed in #343
 * ("fix(ci): auto-merge policy comes from the base branch, and only the repo
 * var enables it") plus one addition on top — the draft guard. #343's rules,
 * unchanged here:
 *   - vars.AGENTFLOW_AUTOMERGE must be the literal string "true" to enable at
 *     all — the repo variable lives in repo settings, out of a PR's reach.
 *   - merge.auto in the policy may only veto (=== false disables); true or
 *     absent does not grant anything on its own.
 *   - the policy is read from the BASE branch, never the PR's own tree — a PR
 *     gets no vote on how it is merged.
 *   - a PR that touches the merge machinery itself (.github/workflows/,
 *     .github/agentic-review.json, .github/actions/, scripts/maintainer.mjs,
 *     scripts/agentflow/) always escalates instead of arming — that
 *     machinery cannot be trusted to judge itself.
 *
 * Actions:
 *   "arm"      — every deterministic condition is satisfied. The workflow may
 *                arm GitHub-native auto-merge (after an optional maintainer
 *                LLM pass, if merge.maintainer is on).
 *   "hold"     — a condition that can still become true later (not approved
 *                yet, ack label missing, PR is a draft) — not an error.
 *   "escalate" — deterministically routed to a human (self-modification hit).
 *   "disabled" — the auto-merge feature itself is off (var/veto switch).
 *
 * The invariant this exists to enforce: action !== "arm" must NEVER attempt
 * to arm auto-merge. On 2026-07-15 that invariant held only by accident for
 * a draft PR — a swallowed GraphQL error, not a declared rule. This function
 * is what makes "draft ⇒ don't arm" a declared, regression-tested rule.
 *
 *   BASE=main PR=1 REPO=owner/repo node scripts/agentflow/merge-gate.mjs
 */

import { execSync } from 'node:child_process'

const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '')
const PINNED_POLICY_PATH = '/tmp/merge-policy.json'

// Identical to #343's guardrail regex (ci.yml, "self-modification guard"):
// `^(\.github/(workflows/|agentic-review\.json|actions/)|scripts/(maintainer\.mjs|agentflow/))`
const SELF_MODIFICATION_RE = /^(\.github\/(workflows\/|agentic-review\.json|actions\/)|scripts\/(maintainer\.mjs|agentflow\/))/

/**
 * @param {object} input
 * @param {boolean} input.draft
 * @param {string} [input.automergeVar]   raw value of vars.AGENTFLOW_AUTOMERGE
 * @param {object} [input.cfg]            the `merge` block of the BASE branch's .github/agentic-review.json
 * @param {string[]} [input.changedFiles]
 * @param {string} input.reviewDecision   APPROVED | COMMENTED | CHANGES_REQUESTED | REVIEW_REQUIRED | ''
 * @param {string[]} [input.labels]
 * @returns {{action: 'arm'|'hold'|'escalate'|'disabled', reason: string}}
 */
export function decideMergeGate({ draft, automergeVar, cfg = {}, changedFiles = [], reviewDecision, labels = [] }) {
  const ackLabel = cfg.ackLabel || 'agentflow:ack'

  // Declared rule (this PR's addition, on top of #343): a draft PR is never
  // armed, full stop. Checked before any other condition, so this can't
  // regress into "arm attempted, GitHub refuses, error swallowed" the way it
  // did on 2026-07-15.
  if (draft) {
    return { action: 'hold', reason: 'PR is a draft — auto-merge is never armed on a draft' }
  }

  // #343: the repo variable is the only thing that can ENABLE. It lives in
  // repo settings, out of a PR's reach.
  if (automergeVar !== 'true') {
    return { action: 'disabled', reason: "auto-merge disabled — vars.AGENTFLOW_AUTOMERGE is not 'true'" }
  }

  // #343: the policy (read from the base branch) may only VETO.
  if (cfg.auto === false) {
    return { action: 'disabled', reason: 'auto-merge vetoed by merge.auto=false in .github/agentic-review.json (base)' }
  }

  // #343: self-modification guard. A PR editing the merge machinery cannot be
  // trusted to judge itself — this is what makes "a PR that edits
  // .github/agentic-review.json cannot change how it is merged" true.
  const selfModHits = changedFiles.filter((f) => SELF_MODIFICATION_RE.test(f))
  if (selfModHits.length > 0) {
    return {
      action: 'escalate',
      reason: `PR touches the merge machinery (${selfModHits.join(', ')}) — escalating instead of auto-merging`,
    }
  }

  if (reviewDecision !== 'APPROVED') {
    return { action: 'hold', reason: `review decision is '${reviewDecision || '(none)'}' (need APPROVED)` }
  }

  if (cfg.requireAck === true && !labels.includes(ackLabel)) {
    return { action: 'hold', reason: `requireAck is on and label '${ackLabel}' is absent` }
  }

  return { action: 'arm', reason: 'not draft, var enabled, not vetoed, no self-modification, APPROVED, ack satisfied' }
}

// ── CLI wrapper — gathers live state, prints one JSON line to stdout ───────
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  const run = (c) => execSync(c, { cwd: ROOT, encoding: 'utf8' }).trim()

  function emit(result) {
    console.error(`[merge-gate] ${result.action} — ${result.reason}`)
    console.log(JSON.stringify(result))
  }

  const pr = process.env.PR
  const repo = process.env.REPO
  const base = process.env.BASE

  // Policy comes from the base branch, never the PR's own tree — same fix as
  // #343. Pinned to /tmp/merge-policy.json so the maintainer step (which also
  // needs base-pinned policy, via AGENTFLOW_POLICY_FILE) can reuse it without
  // re-fetching.
  let cfg
  try {
    execSync(`git fetch --quiet origin ${base}`, { cwd: ROOT, stdio: 'ignore' })
    run(`git show origin/${base}:.github/agentic-review.json > ${PINNED_POLICY_PATH}`)
    cfg = JSON.parse(run(`cat ${PINNED_POLICY_PATH}`)).merge ?? {}
  } catch (err) {
    // Can't verify the policy — fail safe to hold, never arm on an unreadable
    // policy (mirrors #343's fail-safe for the same failure).
    emit({ action: 'hold', reason: `could not read policy from origin/${base}: ${err.message.split('\n')[0]}` })
    process.exit(0)
  }

  let state
  try {
    state = JSON.parse(run(`gh pr view "${pr}" --repo "${repo}" --json isDraft,reviewDecision,labels`))
  } catch (err) {
    emit({ action: 'hold', reason: `could not read PR state: ${err.message.split('\n')[0]}` })
    process.exit(0)
  }

  let changedFiles
  try {
    changedFiles = run(`git diff --name-only origin/${base}...HEAD`).split('\n').filter(Boolean)
  } catch (err) {
    // Can't verify no self-modification path changed — fail safe to escalate
    // rather than silently skipping the guardrail.
    emit({ action: 'escalate', reason: `could not diff against origin/${base}: ${err.message.split('\n')[0]}` })
    process.exit(0)
  }

  emit(
    decideMergeGate({
      draft: state.isDraft === true,
      automergeVar: process.env.VAR_AUTOMERGE,
      cfg,
      changedFiles,
      reviewDecision: state.reviewDecision || '',
      labels: (state.labels || []).map((l) => l.name),
    }),
  )
}

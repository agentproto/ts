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
 * Three modes — ONE script, ONE prompt, ONE guardrail; only the source of the
 * changed-file list and diff differs:
 *
 *   node scripts/maintainer.mjs             # judge the current checkout's diff
 *                                           # vs origin/main. This is how CI
 *                                           # invokes it — DO NOT change its
 *                                           # behaviour or output shape.
 *   node scripts/maintainer.mjs --pr <n>    # judge one already-open PR by number
 *   node scripts/maintainer.mjs --all       # sweep every open PR (one JSON/line)
 *
 * This tool is READ-ONLY against GitHub. It never merges, labels, or comments —
 * it only prints a verdict. Acting on that verdict (arm/merge/escalate) is the
 * caller's job, deliberately kept out of this script's reach.
 *
 * The `--pr`/`--all` modes pull the changed files (`gh pr view --json files`)
 * and diff (`gh pr diff`) from GitHub, and — crucially — read the merge policy
 * from the PR's BASE branch, never the PR's own tree. `AGENTFLOW_POLICY_FILE`
 * is the base-pinned policy path CI passes to the no-args mode; a PR-numbered
 * run fetches the base branch's `.github/agentic-review.json` via `gh api`
 * instead, and never falls back to the working tree. Letting a PR supply its
 * own `alwaysEscalateGlobs` would be a PR grading its own homework — the exact
 * hole this design closes.
 */

import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { runLlm, parseJsonLoose } from './agentflow/llm.mjs'

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const DIFF_LIMIT = 16_000
const run = (c) => execSync(c, { cwd: ROOT, encoding: 'utf8' }).trim()

// The judge engine. Defaults to "cloud" (needs ANTHROPIC_API_KEY) — how CI runs
// it. Set MAINTAINER_ENGINE=local to use the Claude Code CLI for a hand-run.
const ENGINE = process.env.MAINTAINER_ENGINE || 'cloud'

/** Minimal glob: `**` → any, `*` → any non-slash. */
export function matchGlob(file, glob) {
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

/** First changed file matching any always-escalate glob, or undefined. */
export function firstEscalateHit(changedFiles, escalateGlobs = []) {
  return changedFiles.find((f) => escalateGlobs.some((g) => matchGlob(f, g)))
}

/** Read the `merge` block out of an agentic-review.json string. */
export function extractMergeCfg(jsonText) {
  return JSON.parse(jsonText).merge ?? {}
}

/** Keep the diff bounded for the judge prompt (shared by every mode). */
export function truncateDiff(text) {
  return String(text).slice(0, DIFF_LIMIT)
}

/**
 * Parse argv (already sliced past `node script`) into a mode.
 * @returns {{ mode: 'local'|'pr'|'all', pr: number|null }}
 */
export function parseArgs(argv) {
  const out = { mode: 'local', pr: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--all') out.mode = 'all'
    else if (a === '--pr') {
      out.mode = 'pr'
      out.pr = Number(argv[++i])
    } else if (a.startsWith('--pr=')) {
      out.mode = 'pr'
      out.pr = Number(a.slice('--pr='.length))
    } else {
      throw new Error(`unknown argument: ${a}`)
    }
  }
  if (out.mode === 'pr' && !Number.isInteger(out.pr)) {
    throw new Error('--pr requires an integer PR number')
  }
  return out
}

/** The single judge prompt — every mode builds it the same way. */
export function buildJudgePrompt(changedFiles, diff) {
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
  return { system, user }
}

function emit(decision, criticality, reason, pr) {
  const tag = pr != null ? `#${pr} ` : ''
  console.error(`[maintainer] ${tag}${decision} (${criticality}) — ${reason}`)
  const obj = { decision, criticality, reason }
  if (pr != null) obj.pr = pr
  console.log(JSON.stringify(obj))
}

/**
 * The shared verdict path: deterministic guardrail first, then the LLM judge,
 * fail-safe to escalate. `pr` is stamped onto the emitted object in PR/all
 * modes and omitted in no-args mode (so CI's output shape is untouched).
 */
async function judge({ changedFiles, escalateGlobs, diff, pr }) {
  const hit = firstEscalateHit(changedFiles, escalateGlobs)
  if (hit) {
    emit('escalate', 'high', `changed file '${hit}' matches an always-escalate path`, pr)
    return
  }
  const { system, user } = buildJudgePrompt(changedFiles, diff)
  try {
    const raw = await runLlm({ system, user, engine: ENGINE })
    const v = parseJsonLoose(raw)
    emit(v.decision === 'merge' ? 'merge' : 'escalate', v.criticality ?? 'medium', v.reason ?? '(no reason)', pr)
  } catch (err) {
    // A failed judge must never silently auto-merge — fail safe to escalate.
    emit('escalate', 'high', `maintainer judge failed (${err.message}) — escalating to be safe`, pr)
  }
}

// ── no-args mode (how CI calls it) ─────────────────────────────────────────────

/**
 * Merge policy for no-args mode — read from AGENTFLOW_POLICY_FILE when set.
 *
 * The workflow pins that to the *base branch's* copy of agentic-review.json.
 * Falling back to the in-tree copy means reading the PR's own file, which is a
 * PR grading its own homework: `alwaysEscalateGlobs` is the deterministic
 * guardrail, and a PR could simply empty it. The env var is the trustworthy
 * path; the fallback is for running this script by hand on a local checkout.
 */
function localMergeCfg() {
  const pinned = process.env.AGENTFLOW_POLICY_FILE
  try {
    return extractMergeCfg(readFileSync(pinned || `${ROOT}/.github/agentic-review.json`, 'utf8'))
  } catch {
    return {}
  }
}

async function runLocal() {
  const cfg = localMergeCfg()
  const escalateGlobs = Array.isArray(cfg.alwaysEscalateGlobs) ? cfg.alwaysEscalateGlobs : []

  // origin/main is provided by the agent-setup harness; fetch defensively
  // anyway, and if the diff still can't be computed, fail SAFE with a valid
  // escalate verdict rather than crashing into "maintainer output unreadable".
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

  let diff = ''
  try {
    diff = truncateDiff(run('git diff origin/main...HEAD'))
  } catch {
    /* fall back to judging on the file list alone */
  }

  await judge({ changedFiles, escalateGlobs, diff })
}

// ── PR modes (--pr / --all) ────────────────────────────────────────────────────

function repoSlug() {
  return run('gh repo view --json nameWithOwner --jq .nameWithOwner')
}

/**
 * Fetch the merge policy from a PR's BASE branch — never the PR's own tree.
 * `gh api …/contents/…?ref=<base>` returns the file base64-encoded.
 */
function fetchBaseMergeCfg(repo, baseRef) {
  const b64 = run(`gh api "repos/${repo}/contents/.github/agentic-review.json?ref=${baseRef}" --jq .content`)
  return extractMergeCfg(Buffer.from(b64, 'base64').toString('utf8'))
}

async function judgePr(pr, repo = repoSlug()) {
  let state
  try {
    state = JSON.parse(run(`gh pr view ${pr} --repo ${repo} --json number,state,baseRefName,files`))
  } catch (err) {
    emit('escalate', 'high', `could not read PR #${pr}: ${err.message.split('\n')[0]}`, pr)
    return
  }

  // Closed/merged PR: report and move on — there is nothing to judge, and this
  // must never read as a merge verdict.
  if (state.state !== 'OPEN') {
    console.error(`[maintainer] #${pr} is ${state.state} — not judging`)
    console.log(
      JSON.stringify({ decision: 'skip', criticality: 'none', reason: `PR #${pr} is ${state.state} — not open`, pr }),
    )
    return
  }

  // Policy from the BASE branch, never the PR's copy (see file header). A policy
  // we cannot read means we cannot trust the guardrail — fail safe to escalate.
  let escalateGlobs
  try {
    const cfg = fetchBaseMergeCfg(repo, state.baseRefName)
    escalateGlobs = Array.isArray(cfg.alwaysEscalateGlobs) ? cfg.alwaysEscalateGlobs : []
  } catch (err) {
    emit('escalate', 'high', `could not read base policy from ${state.baseRefName}: ${err.message.split('\n')[0]}`, pr)
    return
  }

  const changedFiles = (state.files || []).map((f) => f.path)
  let diff = ''
  try {
    diff = truncateDiff(run(`gh pr diff ${pr} --repo ${repo}`))
  } catch {
    /* fall back to judging on the file list alone */
  }

  await judge({ changedFiles, escalateGlobs, diff, pr })
}

async function runAll() {
  const repo = repoSlug()
  let prs
  try {
    prs = JSON.parse(run(`gh pr list --repo ${repo} --state open --json number --limit 200`))
  } catch (err) {
    console.error(`[maintainer] could not list open PRs: ${err.message.split('\n')[0]}`)
    process.exitCode = 1
    return
  }
  if (prs.length === 0) console.error('[maintainer] no open PRs')
  for (const { number } of prs) {
    await judgePr(number, repo)
  }
}

// ── entry ──────────────────────────────────────────────────────────────────────

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  const { mode, pr } = parseArgs(process.argv.slice(2))
  if (mode === 'local') await runLocal()
  else if (mode === 'pr') await judgePr(pr)
  else await runAll()
}

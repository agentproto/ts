/**
 * review primitive — the read-only JUDGE.
 *
 * Produces a structured verdict for the branch diff vs origin/main, engine-
 * routed (local Claude CLI / cloud API). Deliberately **fresh every call**:
 * independence is what makes the judgment trustworthy. For a re-review, pass
 * `priorFindings` so it verifies resolution + spots new issues — but as DATA,
 * not as the actor's session (sharing that would bias it toward approving its
 * own fixes).
 *
 * Pairs with the `code` primitive (the read-write ACTOR). Flows compose them:
 * a standalone review is just this; the review-loop is review → code → review.
 */

import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runLlm, parseJsonLoose, parseLastJsonObject } from '../llm.mjs'
import { connectDaemon, readDaemonToken, readSessionTail, runWorkflowFile } from '../../lib/daemon-mcp.mjs'

export const DIFF_CAP = 16_000

/**
 * execSync defaults to a 1 MB maxBuffer and throws ENOBUFS past it — which
 * means the reviewer used to die outright on exactly the PRs most worth
 * reviewing. A catalog sync (+11k/-10k lines of generated data) blows through
 * 1 MB in `git diff`, and the failure surfaces as a bare `spawnSync /bin/sh
 * ENOBUFS`, nothing that points at the diff size.
 *
 * The diff is truncated to DIFF_CAP downstream anyway, so a generous buffer
 * costs nothing but transient memory and turns a hard crash into the normal
 * truncation path.
 */
const EXEC_MAX_BUFFER = 256 * 1024 * 1024

const defaultExec = (cmd, root) =>
  execSync(cmd, { cwd: root, encoding: 'utf8', maxBuffer: EXEC_MAX_BUFFER })

/** Collect the branch diff vs origin/main (three-dot = merge-base: what the
 *  branch introduces, independent of how far main has moved).
 *
 *  Fetches origin/main fresh first (non-fatal on failure — e.g. no network).
 *  Without this, a long-lived checkout with a stale local origin/main ref
 *  computes the merge-base against an outdated point: if another PR merged
 *  the same or overlapping content upstream since the last fetch, the diff
 *  picks up that already-landed, unrelated history as if it were new,
 *  ballooning the reviewed file count with content the actual push never
 *  touched (reproduced live: a stale ref made this review 13 files instead
 *  of the 1 file actually changed).
 *
 *  `exec` is injectable for tests — defaults to the real execSync-backed
 *  implementation. */
/** Fetch origin/main fresh (non-fatal on failure) and return just the changed
 *  file names + count vs it — no full diff body. Shared by `gatherDiff` and
 *  by callers (the daemon review engine) that only need file names/counts:
 *  the daemon-driven reviewer reads the live checkout itself, so pre-reading
 *  a diff that can run to hundreds of MB (see EXEC_MAX_BUFFER above) would be
 *  pure waste. `exec` is injectable for tests. */
export function gatherChangedFiles(root, exec = defaultExec) {
  try {
    // Explicit refspec, not just `git fetch origin main` -- a clone with a
    // narrowed fetch refspec (--single-branch, or an actions/checkout PR
    // checkout) would otherwise only update FETCH_HEAD and leave
    // origin/main itself stale, silently no-op'ing this exact fix.
    exec('git fetch origin +refs/heads/main:refs/remotes/origin/main --quiet', root)
  } catch {
    // Non-fatal: proceed with whatever local origin/main ref is already
    // present. A stale ref can widen the reviewed diff (see above), but
    // failing the hook outright over a network hiccup is worse than a
    // slightly-stale review.
  }
  const changedFiles = exec('git diff --name-only origin/main...HEAD', root).trim()
  return { changedFiles, fileCount: changedFiles ? changedFiles.split('\n').length : 0 }
}

export function gatherDiff(root, cap = DIFF_CAP, exec = defaultExec) {
  const { changedFiles, fileCount } = gatherChangedFiles(root, exec)
  const full = changedFiles ? exec('git diff origin/main...HEAD', root) : ''
  return {
    changedFiles,
    fileCount,
    diff: full.slice(0, cap),
    truncated: full.length > cap,
  }
}

const SYSTEM = `You are a senior code reviewer for the @agentproto/ts monorepo.
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

/** Run one review. Returns { decision, summary, findings[] }. Throws on a
 *  non-JSON / unreachable engine so callers decide how fatal that is. */
export async function reviewDiff({ changedFiles, diff, priorFindings, engine, model, claudeBin }) {
  let user = `Changed files:\n${changedFiles}\n\nDiff (may be truncated):\n${diff}`
  if (priorFindings?.length) {
    user +=
      `\n\nThese were flagged in the PREVIOUS round. Verify each against the diff ` +
      `above: drop the ones now resolved, keep any still unaddressed, and add any ` +
      `NEW issues the fixes introduced:\n` +
      priorFindings
        .map((f, i) => `${i + 1}. [${f.severity ?? '?'}] ${f.file ?? ''}: ${f.note ?? ''}`)
        .join('\n')
  }
  const raw = await runLlm({ system: SYSTEM, user, engine, model, claudeBin })
  const verdict = parseJsonLoose(raw)
  verdict.findings = Array.isArray(verdict.findings) ? verdict.findings : []
  return verdict
}

// ── engine "daemon" — the SAME review the CI lane runs ──────────────────────

const PR_REVIEW_WORKFLOW = ['.github', 'agentproto-workflows', 'pr-review', 'WORKFLOW.md']

/** Build the `reviewConfig` input for a "local" placement run of the pr-review
 *  workflow: the parsed `.github/agentic-review.json`, with `reviewerSandbox`
 *  removed (a local daemon run must be a HOST spawn on the dev's own daemon —
 *  otherwise `sandboxRefFor` would try to route it through e2b, which the
 *  dev's daemon has no way to provision) and `reviewerAdapter` overridden by
 *  `adapterOverride` when given (default: keep the file's value — a dev's
 *  daemon typically has `claude-code` available, not the CI lane's
 *  `claude-sdk`). */
function buildDaemonReviewConfig(root, adapterOverride) {
  const raw = readFileSync(join(root, '.github', 'agentic-review.json'), 'utf8')
  const reviewConfig = JSON.parse(raw)
  delete reviewConfig.reviewerSandbox
  if (adapterOverride) reviewConfig.reviewerAdapter = adapterOverride
  return reviewConfig
}

/**
 * Run the review primitive via engine "daemon": the SAME
 * `.github/agentproto-workflows/pr-review/WORKFLOW.md` the CI lane runs, in
 * `placement: "local"`, driven through the developer's already-running local
 * agentproto daemon over MCP (`scripts/lib/daemon-mcp.mjs`). No diff cap —
 * the agent reads the live checkout itself (see `gatherChangedFiles`).
 *
 * `client` is the connected MCP client; pass one in to reuse a connection
 * made upfront (so a caller can surface "daemon unreachable" distinctly from
 * "review failed") or for tests. When omitted, connects fresh using `port`.
 *
 * Returns `{ decision: 'approve' | 'request_changes', summary, findings[] }`
 * — same shape `reviewDiff` returns, so callers don't need to branch on it.
 * Throws a clear error when the run produced no session, or the session's
 * final output has no parseable verdict.
 */
export async function reviewViaDaemon({
  root,
  baseRef = 'main',
  port = 18790,
  timeoutMs = 15 * 60_000,
  pollMs,
  adapter,
  client,
  onStatus,
}) {
  const reviewConfig = buildDaemonReviewConfig(root, adapter)
  const daemonClient = client ?? (await connectDaemon({ port, token: readDaemonToken({ port }) }))
  const path = join(root, ...PR_REVIEW_WORKFLOW)
  const { runId, sessionIds } = await runWorkflowFile(daemonClient, {
    path,
    input: { placement: 'local', baseRef, prNumber: 0, reviewConfig },
    cwd: root,
    timeoutMs,
    pollMs,
    onStatus,
  })
  const sessionId = sessionIds.at(-1)
  if (!sessionId) {
    throw new Error(`[agentflow] daemon review: run ${runId} produced no session id`)
  }
  const tail = await readSessionTail(daemonClient, sessionId)
  let raw
  try {
    // The verdict is the agent's FINAL message — parse the last object, not
    // the first-brace…last-brace slice (earlier prose may contain braces).
    raw = parseLastJsonObject(tail)
  } catch {
    throw new Error(`[agentflow] daemon review: no parseable verdict in session ${sessionId} output`)
  }
  return {
    // Unknown/garbage conclusions fall to "request_changes" — silently
    // treating an unparseable verdict as an approval would be worse than a
    // false negative.
    decision: raw.conclusion === 'approve' ? 'approve' : 'request_changes',
    summary: raw.summary ?? '',
    findings: Array.isArray(raw.findings) ? raw.findings : [],
  }
}

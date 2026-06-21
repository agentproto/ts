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
import { runLlm, stripFences } from '../llm.mjs'

export const DIFF_CAP = 16_000

/** Collect the branch diff vs origin/main (three-dot = merge-base: what the
 *  branch introduces, independent of how far main has moved). */
export function gatherDiff(root, cap = DIFF_CAP) {
  const changedFiles = execSync('git diff --name-only origin/main...HEAD', {
    cwd: root,
    encoding: 'utf8',
  }).trim()
  const full = changedFiles
    ? execSync('git diff origin/main...HEAD', { cwd: root, encoding: 'utf8' })
    : ''
  return {
    changedFiles,
    fileCount: changedFiles ? changedFiles.split('\n').length : 0,
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
  const verdict = JSON.parse(stripFences(raw))
  verdict.findings = Array.isArray(verdict.findings) ? verdict.findings : []
  return verdict
}

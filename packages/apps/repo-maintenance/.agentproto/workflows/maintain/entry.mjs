// Runtime source of truth for WORKFLOW.md's step graph (mirrors
// `@agentproto/worktree`'s routines/worktree-gc-notify/entry.mjs pattern) —
// the frontmatter mirrors this by id+kind for governance (`reconcileEntry`
// only checks the top-level id/kind sequence, never nested step bodies).
//
// This has to be entry-based for ONE reason: the `review` map step's
// per-candidate `model` selector picks haiku vs sonnet from `item
// .residualFileCount` at RUN time. `@agentproto/workflow`'s `defineWorkflow`
// (the pure-.md / TS-authored path) hard-rejects a non-string `model` on a
// `kind:"agent"` step — "a run-time selector is only available on the
// TS-authored runtime step" — and a plain WORKFLOW.md frontmatter can't hold
// a JS function at all (YAML has no function literal). The `entry:` loader
// path is the one place a real Selector function survives: `loadWorkflowHandle`
// returns this module's default export UNVALIDATED by `defineWorkflow`,
// then `compileWorkflow` passes an agent step's function-valued `prompt`
// (and, since `compileAgentStep` never type-checks `model`, its `model` too)
// straight through.

import { tmpdir } from "node:os"
import { join } from "node:path"

const DEFAULT_REVIEW_MODEL_SMALL = "claude-haiku-4-5-20251001"
const DEFAULT_REVIEW_MODEL_LARGE = "claude-sonnet-5"
/** Reviews per run — 500+ candidates in one run is hours of agent turns;
 *  daily runs walk the backlog instead (a reviewed tip is skipped next time). */
const DEFAULT_MAX_REVIEWS = 40
/** Longest name list the markdown report inlines; the full lists are in the
 *  run output (`gaps`, …). */
const REPORT_LIST_CAP = 20

const REVIEWER_REF = "@agentproto/repo-maintenance-reviewer"

/** Where review worktrees live — must match `reviewWorktreeRoot()` in
 *  `@agentproto/runtime` (review-worktree.ts), which refuses any other path. */
const REVIEW_WORKTREE_ROOT = join(tmpdir(), "agentproto-maintain-review")

/** Every reviewer works in its OWN disposable detached worktree of the tip
 *  under review (`item.reviewWorktree`), never in the live checkout. A
 *  reviewer once ran `git stash && git checkout <old branch>` in the user's
 *  main checkout — stashing their WIP and deleting the directory every later
 *  reviewer was spawned in. In its own worktree a checkout or reset harms
 *  nothing; the worktree is removed when the item ends, again right after
 *  the review map, and once more in `finally` (failure / cancel). */
const REVIEWER_CWD = "$item.reviewWorktree"

/** `<root>/<repoName>-<tip sha>` — deterministic per item, so every step of
 *  an item (and the cleanup) names the same path without sharing state. */
function reviewWorktreePath(repoName, sha) {
  return join(REVIEW_WORKTREE_ROOT, `${String(repoName ?? "repo").replace(/[^A-Za-z0-9._-]/g, "_")}-${sha}`)
}

const REVIEW_WORKTREE = (id, action) => ({
  id,
  kind: "tool",
  tool: "branch_gc_review_worktree",
  inputs:
    action === "add"
      ? { repoRoot: "$steps.branchGcPlan.plan.repoRoot", action: "add", path: "$item.reviewWorktree", sha: "$item.sha" }
      : { repoRoot: "$steps.branchGcPlan.plan.repoRoot", action: "remove", paths: ["$item.reviewWorktree"] },
})

const REVIEW_PROMPT =
  "Review the {{item.kind}} branch `{{item.name}}` (tip {{item.sha}}) in the repo at " +
  "{{item.reviewWorktree}}. It is unmerged relative to base " +
  "{{steps.branchGcPlan.plan.base}} (base sha {{item.base}})" +
  "{{#item.compareBase}}, compare base {{item.compareBase}} (pre-rewrite history — commit " +
  "shas from that history do not exist on the current base; compare CONTENT, not shas){{/item.compareBase}}. " +
  "\n\nCoverage already proved what's in base by content: {{item.coverage}}. The residual files " +
  "NOT provably in base are: {{item.residualFiles}}. Merge base: {{item.mergeBase}}. Merged tree " +
  "(the tree base would have if this branch merged cleanly, or null when the merge conflicts): " +
  "{{#item.mergedTree}}{{item.mergedTree}}{{/item.mergedTree}}{{^item.mergedTree}}null{{/item.mergedTree}}. Ahead {{item.ahead}}, behind {{item.behind}}. Push state: {{item.pushed}}. " +
  "Every ref sharing this tip: {{item.refs}}." +
  "\n\n{{item.reviewWorktree}} (your working directory) is a disposable detached worktree made " +
  "for this review alone and deleted afterwards. Read the branch through its sha (git log/show/" +
  "diff/ls-tree, `git show <sha>:<path>` for a file); never checkout, switch, stash, reset or " +
  "modify files — the stash list and refs are shared with every other checkout of this repo." +
  "\n\nRecord your verdict by calling branch_gc_verdict with repoRoot=" +
  "\"{{item.reviewWorktree}}\", name=\"{{item.name}}\", sha=\"{{item.sha}}\", " +
  "a triage block, and — ONLY when you agree deleting this branch loses nothing of value — a " +
  "gate block with agree:true and non-empty evidence. Call branch_gc_verdict exactly once for " +
  "this branch, then stop."

const NUDGE_PROMPT =
  "You did not call branch_gc_verdict for `{{item.name}}` (tip {{item.sha}}) — no verdict is " +
  "stored for that sha. Call it now with your verdict: repoRoot=\"{{item.reviewWorktree}}\", " +
  "name=\"{{item.name}}\", sha=\"{{item.sha}}\", a triage block, and a gate block only if you agree " +
  "deletion loses nothing. Do not re-review; just record it, then stop."

/** Read-only store lookup for the current item's tip — `branch_gc_verdict_get`
 *  answers `{ found, missing, record }` without re-running a whole plan. */
const VERDICT_CHECK = id => ({
  id,
  kind: "tool",
  tool: "branch_gc_verdict_get",
  inputs: { repoRoot: "$steps.branchGcPlan.plan.repoRoot", sha: "$item.sha" },
})

/** One `review`-class branch_gc plan entry per unique tip sha — a local
 *  branch and its remote twin share a tip, so they share one review instead
 *  of costing the reviewer two turns. Mirrors `branchReviewQueue()`
 *  (`packages/worktree/src/branch-gc.ts`), reimplemented here because that
 *  function isn't exposed through the `branch_gc` MCP tool (only the CLI's
 *  `review-queue` subcommand calls it directly) — including its skip of a
 *  tip that already carries a stored verdict (verdicts are keyed by sha, so
 *  only tips that moved get re-reviewed). Returns the queue (most recent tip
 *  first, then the larger residual) plus how many tips were skipped as
 *  already reviewed. */
export function buildReviewQueue(branchGcPlanResult) {
  const plan = branchGcPlanResult?.plan
  const entries = Array.isArray(plan?.entries) ? plan.entries : []
  const bySha = new Map()
  const reviewedShas = new Set()
  for (const e of entries) {
    if (e.class !== "review") continue
    if (e.verdict) {
      reviewedShas.add(e.sha)
      continue
    }
    const seen = bySha.get(e.sha)
    if (seen) {
      seen.refs.push(e.ref)
      continue
    }
    bySha.set(e.sha, {
      name: e.name,
      kind: e.kind,
      sha: e.sha,
      ageDays: e.ageDays,
      author: e.author,
      subject: e.subject,
      history: e.history,
      base: plan?.baseSha ?? null,
      // branch_gc sets `compareBase` on EVERY unmerged entry (base itself for
      // a current-history tip, the anchor for a pre-rewrite one) — only the
      // pre-rewrite anchor is news to the reviewer, and the prompt's
      // "pre-rewrite history" note keys off this field.
      compareBase: e.history === "pre-rewrite" ? (e.compareBase ?? null) : null,
      mergeBase: e.mergeBase ?? null,
      mergedTree: e.mergedTree ?? null,
      conflicts: e.conflicts ?? null,
      ahead: e.ahead,
      behind: e.behind,
      pushed: e.pushed ?? null,
      coverage: e.coverage ?? null,
      residualFiles: e.residualFiles ?? [],
      residualFileCount: e.residualFileCount ?? 0,
      refs: [e.ref],
    })
  }
  const queue = [...bySha.values()].sort(
    (a, b) =>
      (a.ageDays ?? Number.POSITIVE_INFINITY) - (b.ageDays ?? Number.POSITIVE_INFINITY) ||
      (b.residualFileCount ?? 0) - (a.residualFileCount ?? 0),
  )
  return { queue, alreadyReviewed: reviewedShas.size }
}

/** `maxReviews` as a non-negative integer, else the default. */
function reviewCap(input) {
  const n = input?.maxReviews
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_MAX_REVIEWS
}

/** `names` as inline code, at most `cap` of them, then `… and N more`. */
export function formatNameList(names, cap = REPORT_LIST_CAP) {
  const shown = names.slice(0, cap).map(n => `\`${n}\``).join(", ")
  return names.length > cap ? `${shown}, … and ${names.length - cap} more` : shown
}

/** Distinct error messages of a tolerant fan-out's rejected items, most
 *  frequent first: `[{ error, count }]`. */
export function tallyReviewErrors(review) {
  const counts = new Map()
  for (const r of Array.isArray(review?.results) ? review.results : []) {
    if (r?.status !== "rejected") continue
    counts.set(r.error, (counts.get(r.error) ?? 0) + 1)
  }
  return [...counts].map(([error, count]) => ({ error, count })).sort((a, b) => b.count - a.count)
}

/** Shas of candidates a tolerant fan-out never started (spawn circuit
 *  breaker open) — not reviewed, which is not the same as a gap. */
function skippedShas(reviewCandidates, review) {
  const out = new Set()
  for (const r of Array.isArray(review?.results) ? review.results : []) {
    if (r?.status === "skipped") {
      const c = reviewCandidates?.[r.index]
      if (c) out.add(c.sha)
    }
  }
  return out
}

/** Candidates from the FIRST plan that still have no recorded verdict after
 *  the review map ran — `classifyRef` (branch-gc.ts) stamps `entry.verdict`
 *  for ANY unmerged ref with a stored verdict for its exact tip sha,
 *  regardless of `includeReviewed`, so a second plan is a cheap, accurate
 *  "did every candidate get reviewed" check with no separate verdict-read
 *  tool needed. A candidate the review map never started (circuit open) is
 *  not a gap — it's reported as not reviewed. */
export function computeReviewGaps(reviewCandidates, branchGcVerifyResult, review) {
  const afterEntries = branchGcVerifyResult?.plan?.entries
  const verdictShas = new Set(
    (Array.isArray(afterEntries) ? afterEntries : [])
      .filter(e => e.verdict)
      .map(e => e.sha),
  )
  const skipped = skippedShas(reviewCandidates, review)
  return (reviewCandidates ?? [])
    .filter(c => !verdictShas.has(c.sha) && !skipped.has(c.sha))
    .map(c => ({ name: c.name, sha: c.sha, refs: c.refs }))
}

function countOutcomes(outcomes, result) {
  return (Array.isArray(outcomes) ? outcomes : []).filter(o => o.result === result).length
}

/** `{ key: count }` over `values`, in first-seen order. */
function tally(values) {
  const counts = {}
  for (const v of values) counts[v] = (counts[v] ?? 0) + 1
  return counts
}

function formatTally(counts) {
  return Object.entries(counts).map(([k, n]) => `${k}=${n}`).join(" ")
}

/** Per-class counts of a `worktree_gc` DRY RUN. The tool returns
 *  `{ mode: "plan", plan: GcPlanEntry[] }` — `plan` is the entry array itself
 *  (`makeWorktreeGcRunner`, packages/cli/src/commands/worktree.ts), NOT a
 *  branch_gc-style `{ plan: { entries } }` object. */
export function summarizeWorktreePlan(worktreeGcPlanResult) {
  const entries = Array.isArray(worktreeGcPlanResult?.plan) ? worktreeGcPlanResult.plan : []
  const byClass = { reclaim: 0, salvage: 0, hold: 0 }
  for (const e of entries) byClass[e.class] = (byClass[e.class] ?? 0) + 1
  return { total: entries.length, byClass }
}

/** The stored verdict of every review candidate, read off the verify plan
 *  (`classifyRef` stamps `entry.verdict` for any unmerged ref with a verdict
 *  for its exact tip) — one per candidate sha, so a local+remote twin counts
 *  once. */
export function collectCandidateVerdicts(reviewCandidates, branchGcVerifyResult) {
  const bySha = new Map()
  for (const e of branchGcVerifyResult?.plan?.entries ?? []) {
    if (e.verdict && !bySha.has(e.sha)) bySha.set(e.sha, e.verdict)
  }
  const out = []
  for (const c of reviewCandidates ?? []) {
    const v = bySha.get(c.sha)
    if (v) out.push({ name: c.name, sha: c.sha, triage: v.triage, agree: v.agree ?? null })
  }
  return out
}

export function buildReport(b) {
  const wtPlan = b.steps.worktreeGcPlan
  const bgPlan = b.steps.branchGcPlan
  const plan = bgPlan?.plan
  const summary = bgPlan?.summary
  const reviewCandidates = b.steps.reviewCandidates ?? []
  const reviewQueue = b.steps.reviewQueue ?? { queue: reviewCandidates, alreadyReviewed: 0 }
  const review = b.steps.review
  const reviewOutcome = Array.isArray(review)
    ? { succeeded: review.length, failed: 0, skipped: 0 }
    : { succeeded: 0, failed: 0, skipped: 0, ...(review ?? {}) }
  const reviewErrors = tallyReviewErrors(review)
  const gaps = b.steps.gaps ?? []
  const verdicts = collectCandidateVerdicts(reviewCandidates, b.steps.branchGcVerify)
  const applyMerged = b.input?.applyMerged === true
  const branchGcApply = b.steps.branchGcApply
  const worktreeGcApply = b.steps.worktreeGcApply

  const lines = []
  lines.push(`# Repo maintenance — ${plan?.repoName ?? plan?.repoRoot ?? "unknown repo"}`)
  lines.push("")
  lines.push(`Base \`${plan?.base ?? "?"}\` @ \`${(plan?.baseSha ?? "").slice(0, 10)}\`${plan?.anchor ? ` (anchor \`${plan.anchor.slice(0, 10)}\`)` : ""}`)
  lines.push("")
  lines.push("## Worktrees")
  const wt = summarizeWorktreePlan(wtPlan)
  lines.push(`- mode: \`${wtPlan?.mode ?? "plan"}\` — ${wt.total} worktree(s) classified`)
  lines.push(`- reclaim=${wt.byClass.reclaim} salvage=${wt.byClass.salvage} hold=${wt.byClass.hold}`)
  lines.push("")
  lines.push("## Branches")
  for (const kind of plan?.scopes ?? []) {
    const c = summary?.byClass?.[kind]
    if (!c) continue
    lines.push(`- **${kind}**: reclaim=${c.reclaim} review=${c.review} hold=${c.hold}`)
  }
  if (plan?.otherRemoteRefs) lines.push(`- (${plan.otherRemoteRefs} ref(s) of other configured remotes left alone)`)
  lines.push("")
  lines.push(`## Review (${reviewCandidates.length} candidate(s) this run)`)
  const backlog = reviewQueue.queue.length - reviewCandidates.length
  lines.push(
    `- queue: ${reviewQueue.queue.length} unreviewed tip(s), newest first — ${reviewCandidates.length} picked for this run` +
      (backlog > 0 ? `, not reviewed this run (${backlog}) — raise \`maxReviews\` or let the next run take them` : "") +
      (reviewQueue.alreadyReviewed > 0 ? `; ${reviewQueue.alreadyReviewed} tip(s) already carry a verdict from an earlier run` : ""),
  )
  lines.push(
    `- reviewer agent turns: ${reviewOutcome.succeeded} ok, ${reviewOutcome.failed} failed` +
      (reviewOutcome.skipped > 0 ? `, ${reviewOutcome.skipped} not started` : ""),
  )
  if (reviewOutcome.circuitOpen) {
    lines.push(
      `- **review stopped early — spawn circuit open** after repeated spawn failures; ` +
        `${reviewOutcome.skipped} candidate(s) not reviewed this run. First error: ${reviewOutcome.circuitOpen.error}`,
    )
  }
  if (reviewErrors.length > 0) {
    lines.push(`- failure reasons (${reviewErrors.length} distinct):`)
    for (const { error, count } of reviewErrors.slice(0, REPORT_LIST_CAP)) {
      lines.push(`  - ${count}× ${error.length > 300 ? `${error.slice(0, 300)}…` : error}`)
    }
    if (reviewErrors.length > REPORT_LIST_CAP) lines.push(`  - … and ${reviewErrors.length - REPORT_LIST_CAP} more`)
  }
  if (verdicts.length > 0) {
    lines.push(`- verdicts: ${formatTally(tally(verdicts.map(v => v.triage)))} (deletion agreed on ${verdicts.filter(v => v.agree === true).length})`)
  }
  const salvage = verdicts.filter(v => v.triage === "salvage")
  if (salvage.length > 0) {
    lines.push(`- **salvage — needs a human**: ${formatNameList(salvage.map(v => v.name))}`)
  }
  if (gaps.length > 0) {
    lines.push(`- **${gaps.length} branch(es) with no recorded verdict** (after a same-session re-prompt and a large-model retry; full list in the run output's \`gaps\`): ${formatNameList(gaps.map(g => g.name))}`)
  } else if (reviewCandidates.length > 0 && reviewOutcome.skipped === 0) {
    lines.push("- every review candidate has a recorded verdict")
  }
  lines.push("")
  lines.push("## Apply")
  if (!applyMerged) {
    lines.push("- `applyMerged` is false — dry run only, nothing was deleted.")
  } else {
    lines.push(
      `- branch_gc: ${countOutcomes(branchGcApply?.outcomes, "deleted")} deleted, ` +
        `${countOutcomes(branchGcApply?.outcomes, "failed")} failed` +
        `${branchGcApply?.restoreLog ? ` — restore log: ${branchGcApply.restoreLog}` : ""}`,
    )
    const wtOutcomes = Array.isArray(worktreeGcApply?.outcomes) ? worktreeGcApply.outcomes : []
    lines.push(`- worktree_gc: ${wtOutcomes.length} outcome(s)${wtOutcomes.length > 0 ? ` — ${formatTally(tally(wtOutcomes.map(o => o.result)))}` : ""}`)
    lines.push("- only `reclaim`-class refs were touched — `includeReviewed` was false, so no reviewed-but-agreed branch was reclaimed by this run.")
  }
  lines.push("")
  lines.push("## approve-reviewed (documented seam, not wired)")
  lines.push(
    "Recording a verdict via `branch_gc_verdict` never reclaims a branch by itself. " +
      "A human-in-the-loop gate that reclaims `review`-class branches whose stored " +
      "verdict agreed (`branch_gc`'s `includeReviewed: true`) is a deliberate, " +
      "documented seam — not built here. See the repo-maintenance app README, " +
      "\"Out of scope: the approval gate\".",
  )
  return lines.join("\n")
}

export default {
  name: "Repo Maintenance",
  id: "maintain",
  description:
    "Plan worktree_gc + branch_gc, fan a review agent out over up to " +
    "`maxReviews` unreviewed branch candidates, newest first (small model for " +
    "a small residual, large model otherwise), verify every candidate got a " +
    "verdict, optionally apply " +
    "(reclaim-only) worktree/branch gc, and report — plus an agentpush " +
    "notification when `notify` is set.",
  version: "0.1.0",
  inputs: {
    repoRoot: { type: "string", description: "Absolute path to the git repo. Wins over `workspaceSlug`." },
    workspaceSlug: { type: "string", description: "Workspace slug. The active workspace when both are omitted." },
    applyMerged: { type: "boolean", description: "Execute branch_gc/worktree_gc (reclaim-class only) after review. Default false.", default: false },
    reviewModelSmall: { type: "string", description: `Model for a review candidate with residualFileCount <= 3. Default ${DEFAULT_REVIEW_MODEL_SMALL}.`, default: DEFAULT_REVIEW_MODEL_SMALL },
    reviewModelLarge: { type: "string", description: `Model for a review candidate with residualFileCount > 3. Default ${DEFAULT_REVIEW_MODEL_LARGE}.`, default: DEFAULT_REVIEW_MODEL_LARGE },
    maxReviews: { type: "number", description: `Most review candidates to review this run — newest tip first, then the larger residual. The rest are reported as not reviewed this run; tips with a stored verdict are never re-reviewed, so daily runs walk the backlog. Default ${DEFAULT_MAX_REVIEWS}.`, default: DEFAULT_MAX_REVIEWS },
    notify: {
      type: "object",
      description: "Optional agentpush `to` target ({ channel, address }) to notify with the report when set. Omit for no notification.",
    },
  },
  outputs: {},
  steps: [
    {
      id: "worktreeGcPlan",
      kind: "tool",
      tool: "worktree_gc",
      inputs: { repoRoot: "$input.repoRoot", workspaceSlug: "$input.workspaceSlug", apply: false },
    },
    {
      id: "branchGcPlan",
      kind: "tool",
      tool: "branch_gc",
      inputs: { repoRoot: "$input.repoRoot", workspaceSlug: "$input.workspaceSlug", apply: false, includeReviewed: false },
    },
    {
      id: "reviewQueue",
      kind: "transform",
      compute: b => buildReviewQueue(b.steps.branchGcPlan),
    },
    {
      id: "reviewCandidates",
      kind: "transform",
      compute: b =>
        (b.steps.reviewQueue?.queue ?? [])
          .slice(0, reviewCap(b.input))
          .map(c => ({ ...c, reviewWorktree: reviewWorktreePath(b.steps.branchGcPlan?.plan?.repoName, c.sha) })),
    },
    {
      id: "reviewWorktreePaths",
      kind: "transform",
      compute: b => (b.steps.reviewCandidates ?? []).map(c => c.reviewWorktree),
    },
    {
      id: "review",
      kind: "map",
      over: "$steps.reviewCandidates",
      parallelism: 4,
      onError: "collect",
      steps: [
        REVIEW_WORKTREE("reviewWorktreeAdd", "add"),
        {
          id: "reviewOne",
          kind: "agent",
          agent: { ref: REVIEWER_REF },
          cwd: REVIEWER_CWD,
          prompt: REVIEW_PROMPT,
          model: b => ((b.item?.residualFileCount ?? 0) <= 3
            ? (b.input?.reviewModelSmall || DEFAULT_REVIEW_MODEL_SMALL)
            : (b.input?.reviewModelLarge || DEFAULT_REVIEW_MODEL_LARGE)),
        },
        // A reviewer can end its turn announcing a call it never made. Check
        // the store for THIS tip; if nothing landed, re-prompt the same
        // session once, then retry once with a fresh large-model reviewer.
        // Only a tip still missing after that is a gap (see `gaps`). Every
        // `when` below reads the step right before it — map items share one
        // `$steps` namespace, and only the immediate predecessor's value is
        // guaranteed to be this item's.
        VERDICT_CHECK("verdictCheck"),
        {
          id: "needsNudge",
          kind: "branch",
          branches: [{ when: "$steps.verdictCheck.missing", next: "nudge" }],
          join: "reviewSettled",
        },
        {
          id: "nudge",
          kind: "agent",
          // The session THIS item's `reviewOne` spawned (the host labels a
          // fan-out spawn `<stepId>[<index>]`).
          sessionRef: "reviewOne[{{index}}]",
          prompt: NUDGE_PROMPT,
        },
        VERDICT_CHECK("verdictCheckAfterNudge"),
        {
          id: "needsLargeRetry",
          kind: "branch",
          branches: [{ when: "$steps.verdictCheckAfterNudge.missing", next: "reviewRetryLarge" }],
        },
        {
          id: "reviewRetryLarge",
          kind: "agent",
          agent: { ref: REVIEWER_REF },
          cwd: REVIEWER_CWD,
          prompt:
            REVIEW_PROMPT +
            "\n\nA previous reviewer of this branch ended its turn without recording a verdict. " +
            "Recording the verdict with branch_gc_verdict IS the deliverable — do not end your turn without it.",
          model: b => b.input?.reviewModelLarge || DEFAULT_REVIEW_MODEL_LARGE,
        },
        {
          id: "reviewSettled",
          kind: "transform",
          compute: b => ({ name: b.item?.name, sha: b.item?.sha }),
        },
        REVIEW_WORKTREE("reviewWorktreeRemove", "remove"),
      ],
    },
    {
      // A failed item never reached its own remove — clear every review
      // worktree before anything re-plans or gc's worktrees.
      id: "reviewCleanup",
      kind: "tool",
      tool: "branch_gc_review_worktree",
      inputs: { repoRoot: "$steps.branchGcPlan.plan.repoRoot", action: "remove", paths: "$steps.reviewWorktreePaths" },
    },
    {
      id: "branchGcVerify",
      kind: "tool",
      tool: "branch_gc",
      inputs: { repoRoot: "$input.repoRoot", workspaceSlug: "$input.workspaceSlug", apply: false, includeReviewed: false },
    },
    {
      id: "gaps",
      kind: "transform",
      compute: b => computeReviewGaps(b.steps.reviewCandidates, b.steps.branchGcVerify, b.steps.review),
    },
    {
      id: "branchGcApply",
      kind: "tool",
      tool: "branch_gc",
      inputs: {
        repoRoot: "$input.repoRoot",
        workspaceSlug: "$input.workspaceSlug",
        apply: "$input.applyMerged",
        includeReviewed: false,
        scopes: ["local", "remote", "orphan"],
      },
    },
    {
      id: "worktreeGcApply",
      kind: "tool",
      tool: "worktree_gc",
      inputs: {
        repoRoot: "$input.repoRoot",
        workspaceSlug: "$input.workspaceSlug",
        apply: "$input.applyMerged",
        salvageDirty: false,
      },
    },
    {
      id: "report",
      kind: "transform",
      compute: b => buildReport(b),
    },
    {
      id: "notifyBody",
      kind: "transform",
      compute: b => JSON.stringify({ to: b.input?.notify, content: { text: String(b.steps.report ?? "").slice(0, 3500) } }),
    },
    {
      // Notify only when `notify` is set AND there is something to report
      // (a reclaimable ref or a review candidate) — a daily plan-only sweep
      // over an already-clean repo shouldn't page anyone. `kind:"branch"`'s
      // `when` is always ref-string-resolved (never a function, unlike
      // `map.over`/`agent.model` above), so the boolean itself has to be
      // precomputed here rather than expressed inline.
      id: "shouldNotify",
      kind: "transform",
      compute: b => {
        if (!b.input?.notify) return false
        const byClass = b.steps.branchGcPlan?.summary?.byClass ?? {}
        const hasReclaimable = Object.values(byClass).some(c => (c?.reclaim ?? 0) > 0)
        const hasReviewCandidates = (b.steps.reviewCandidates ?? []).length > 0
        return hasReclaimable || hasReviewCandidates
      },
    },
    {
      id: "maybeNotify",
      kind: "branch",
      branches: [{ when: "$steps.shouldNotify", next: "notify" }],
      default: "skip-notify",
    },
    {
      id: "notify",
      kind: "tool",
      tool: "command_execute",
      inputs: {
        command: "bash",
        args: [
          "-c",
          'curl -s --max-time 30 -X POST -H "Authorization: Bearer ${AGENTPUSH_API_KEY:-}" ' +
            '-H "Content-Type: application/json" https://api.agentpush.io/tools/send_message --data-binary @-',
        ],
        stdin: "$steps.notifyBody",
      },
    },
    {
      id: "skip-notify",
      kind: "gate",
      command: "true",
    },
  ],
  // Always runs — success, failure or cancel: no review worktree outlives the run.
  finally: [
    {
      id: "reviewWorktreesFinally",
      kind: "tool",
      tool: "branch_gc_review_worktree",
      inputs: { repoRoot: "$steps.branchGcPlan.plan.repoRoot", action: "remove", paths: "$steps.reviewWorktreePaths" },
    },
  ],
  result: {
    report: "$steps.report",
    gaps: "$steps.gaps",
    applyMerged: "$input.applyMerged",
    branchGcApply: "$steps.branchGcApply",
    worktreeGcApply: "$steps.worktreeGcApply",
  },
}

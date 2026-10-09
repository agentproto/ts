// Runtime source of truth for WORKFLOW.md's step graph (mirrors
// `@agentproto/worktree`'s routines/worktree-gc-notify/entry.mjs pattern) —
// the frontmatter mirrors this by id+kind for governance (`reconcileEntry`
// only checks the top-level id/kind sequence, never nested step bodies).
//
// This has to be entry-based for ONE reason: the `review` map step's
// per-candidate `model` selector picks the small vs large reviewer model from `item
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

// The reviewer models are model ROLES, not ids here: the `modelRoles` step
// (the daemon's `model_roles` tool) resolves `review.small` / `review.large`
// at run time — explicit input > repo agentproto.json `models` > daemon
// config `models` > built-in default. The one precedence + default table is
// packages/runtime/src/model-roles.ts; nothing below hard-codes a model id.
const ROLE_REVIEW_SMALL = "review.small"
const ROLE_REVIEW_LARGE = "review.large"

/** The model for `role`: the run's explicit input (kept ahead of the tool as a
 *  belt-and-braces — the tool folds the same input in as its top layer) or
 *  the `modelRoles` step's resolution. Undefined leaves the agent's own
 *  AGENT.md `model` in charge. */
export function reviewModel(b, role) {
  const explicit = role === ROLE_REVIEW_SMALL ? b.input?.reviewModelSmall : b.input?.reviewModelLarge
  return explicit || b.steps?.modelRoles?.models?.[role] || undefined
}
/** Reviews per run — 500+ candidates in one run is hours of agent turns;
 *  daily runs walk the backlog instead (a reviewed tip is skipped next time). */
const DEFAULT_MAX_REVIEWS = 40
/** Longest name list the markdown report inlines; the full lists are in the
 *  run output (`gaps`, …). */
const REPORT_LIST_CAP = 20
/** A worktree-held branch is reviewed only once its tip is this old — the
 *  same floor as branch_gc's `minAgeDays` default for `review`. */
const HELD_WORKTREE_MIN_AGE_DAYS = 3

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
  "Refs of this branch (across its tips): {{item.refs}}." +
  "{{#item.worktree}}\n\nThis branch is checked out in the linked worktree {{item.worktree}} — " +
  "idle (no live session), clean tree, no open PR — which is the only reason branch gc held it. " +
  "Your verdict decides whether that worktree (and the branch) can be removed: agree only when " +
  "everything committed on it is in base or not worth keeping. Never touch that worktree; read " +
  "the branch through its sha like any other.{{/item.worktree}}" +
  "{{#item.otherTips}}\n\nThis branch name has OLDER tip(s) besides {{item.sha}} — " +
  "{{item.otherTips}} (JSON array of { sha, refs }; each sha may carry work the newer tip does " +
  "not). The coverage above describes ONLY the primary tip {{item.sha}}. Inspect EVERY sha " +
  "(git log/show/diff/ls-tree, `git show <sha>:<path>` — they are all commits of this repo) " +
  "before deciding.{{/item.otherTips}}" +
  "\n\n{{item.reviewWorktree}} (your working directory) is a disposable detached worktree made " +
  "for this review alone and deleted afterwards. Read the branch through its sha (git log/show/" +
  "diff/ls-tree, `git show <sha>:<path>` for a file); never checkout, switch, stash, reset or " +
  "modify files — the stash list and refs are shared with every other checkout of this repo." +
  "\n\nRecord your verdict by calling branch_gc_verdict with repoRoot=" +
  "\"{{item.reviewWorktree}}\", name=\"{{item.name}}\", the tip's sha, " +
  "a triage block, and — ONLY when you agree deleting that tip's work loses nothing of value — a " +
  "gate block with agree:true and non-empty evidence. Call branch_gc_verdict exactly once per " +
  "tip: once for {{item.sha}}{{#item.otherTips}}, and once for every sha in {{item.otherTips}}{{/item.otherTips}}, then stop."

const NUDGE_PROMPT =
  "You did not call branch_gc_verdict for every tip of `{{item.name}}` — the store is still " +
  "missing verdicts for: {{item.missingShas}} (tip shas of this branch; " +
  "{{item.sha}} is the primary). Call it now for EACH missing sha, with your verdict: " +
  "repoRoot=\"{{item.reviewWorktree}}\", name=\"{{item.name}}\", that sha, a triage block, and a " +
  "gate block only if you agree deleting that tip's work loses nothing. Do not re-review; " +
  "just record the missing verdicts, then stop."

/** Per-tip store lookups for one review item — `branch_gc_verdict_get` answers
 *  `{ sha, found, missing, record }` without re-running a whole plan. A
 *  branch-name item can carry SEVERAL tips (local + remote twins that
 *  diverged), so the check is a sequential (parallelism 1) inner map over the
 *  item's `allTips` tip objects, one lookup per tip; the map's own result is
 *  the array of those answers. */
const VERDICT_CHECK_MAP = id => ({
  id,
  kind: "map",
  over: "$item.allTips",
  parallelism: 1,
  steps: [
    {
      id: `${id}Get`,
      kind: "tool",
      tool: "branch_gc_verdict_get",
      inputs: { repoRoot: "$steps.branchGcPlan.plan.repoRoot", sha: "$item.sha" },
    },
  ],
})

/** Fold the check map's per-tip answers into the item's verdict state. Reads
 *  `$steps.<checkId>` — safe ONLY here, in the transform that runs IMMEDIATELY
 *  after this item's own check map wrote that slot (no await between write and
 *  read, so a concurrent sibling item cannot interleave) — then parks the
 *  result on `$item` (`verdictMissing`, `missingShas`), which is exclusively
 *  this item's, so the branch/prompt that follow never race a sibling's
 *  overwrite of the shared `$steps` slot. */
const VERDICT_NEEDS = (id, checkId) => ({
  id,
  kind: "transform",
  compute: b => {
    const answers = Array.isArray(b.steps[checkId]) ? b.steps[checkId] : []
    const missingShas = answers.filter(r => r?.missing === true).map(r => r.sha)
    b.item.verdictMissing = missingShas.length > 0
    b.item.missingShas = missingShas
    return { missing: missingShas.length > 0, missingShas }
  },
})

/** Linked worktrees whose branch is worth an LLM review: idle (no live
 *  session), clean tree, and no open PR — `path → branch`. branch_gc holds
 *  every branch checked out in a worktree (`holdReason: "worktree"`) and
 *  worktree_gc holds every worktree whose branch isn't provably merged, so
 *  without this an abandoned-but-unmerged worktree is held by both forever.
 *  `worktree_gc`'s dry run never lists the main checkout, so its branch is
 *  never a candidate. A dirty tree is left out: its WIP isn't on the tip a
 *  reviewer reads. */
export function reviewableWorktrees(worktreeGcPlanResult) {
  const out = new Map()
  const entries = Array.isArray(worktreeGcPlanResult?.plan) ? worktreeGcPlanResult.plan : []
  for (const w of entries) {
    if (w?.class !== "hold" || !w.branch || !w.path) continue
    if (w.liveness?.state !== "idle" || treeState(w.tree) !== "clean") continue
    if (w.integration?.state === "open") continue
    out.set(w.path, w.branch)
  }
  return out
}

/** A worktree_gc plan entry's tree state. The daemon's `worktree_gc` tool
 *  flattens it to the bare discriminant (`tree: "clean"`, `toGcPlanEntryView`
 *  in packages/cli/src/commands/worktree.ts); the engine's own `GcPlanEntry`
 *  (and `agentproto worktree gc --json`) carries `{ state, … }`. */
function treeState(tree) {
  return typeof tree === "string" ? tree : tree?.state
}

/** The worktree path a branch_gc entry is held by, when that hold is the only
 *  thing between it and `review`: held for `worktree`, unmerged, old enough,
 *  and the worktree is one {@link reviewableWorktrees} kept. Else null. */
function heldWorktreeOf(e, heldWorktrees) {
  if (e?.class !== "hold" || e.holdReason !== "worktree" || e.status !== "unmerged") return null
  if ((e.ageDays ?? 0) < HELD_WORKTREE_MIN_AGE_DAYS) return null
  return heldWorktrees.get(e.holdDetail) === e.name ? e.holdDetail : null
}

/** One line per reviewed held worktree (from the verify plan's stored
 *  verdicts): what the reviewer said, and — when it agreed nothing of value
 *  is lost — the command that removes it. Removal stays a human step. */
export function heldWorktreeVerdicts(branchGcVerifyResult, worktreeGcPlanResult) {
  const held = reviewableWorktrees(worktreeGcPlanResult)
  const byPath = new Map()
  for (const e of branchGcVerifyResult?.plan?.entries ?? []) {
    const path = heldWorktreeOf(e, held)
    if (!path || !e.verdict || byPath.has(path)) continue
    byPath.set(path, { name: e.name, path, sha: e.sha, triage: e.verdict.triage, agree: e.verdict.agree ?? null })
  }
  return [...byPath.values()]
}

/** One `review`-class branch_gc plan entry per BRANCH NAME — a local branch
 *  and its remote twin share one review instead of costing the reviewer two
 *  turns, whether they share a tip (grouped by sha, as before) or DIVERGED
 *  (`foo` @ newer sha, `origin/foo` @ older sha: one reviewer inspects both
 *  tips — the older one may carry work the newer does not). Mirrors
 *  `branchReviewQueue()` (`packages/worktree/src/branch-gc.ts`), reimplemented
 *  here because that function isn't exposed through the `branch_gc` MCP tool
 *  (only the CLI's `review-queue` subcommand calls it directly) — including
 *  its skip of a tip that already carries a stored verdict (verdicts are
 *  keyed by sha, so only tips that moved get re-reviewed).
 *
 *  The merged item keeps the NEWEST unreviewed tip as its primary `sha`
 *  (with that tip's coverage fields) and carries the older unreviewed tips
 *  as `otherTips` (`[{ sha, refs }]`, newest first); `allTips` lists every
 *  unreviewed tip and `refs` is the union across them. A name is
 *  "already reviewed" — and left out of the queue — only when EVERY review
 *  tip under that name carries a verdict; a partially reviewed name stays
 *  queued with only its unreviewed tips. Returns the queue (oldest first,
 *  then the larger residual) plus how many names were skipped as already
 *  reviewed. */
export function buildReviewQueue(branchGcPlanResult, worktreeGcPlanResult, opts = {}) {
  const plan = branchGcPlanResult?.plan
  const entries = Array.isArray(plan?.entries) ? plan.entries : []
  const heldWorktrees = opts.reviewHeldWorktrees === false ? new Map() : reviewableWorktrees(worktreeGcPlanResult)
  const reviewable = e => e.class === "review" || heldWorktreeOf(e, heldWorktrees) !== null
  const bySha = new Map()
  const dates = new Map()
  for (const e of entries) {
    if (!reviewable(e)) continue
    dates.set(e.sha, e.date ?? "")
    if (e.verdict) continue
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
      ...(heldWorktreeOf(e, heldWorktrees) ? { worktree: heldWorktreeOf(e, heldWorktrees) } : {}),
    })
  }
  // Merge candidates whose refs share one branch NAME: `foo` and `origin/foo`
  // with different tips were two queue items and two reviewers (4 of 40
  // reviewer turns wasted in dogfood run 4).
  const byName = new Map()
  for (const c of bySha.values()) {
    const sibs = byName.get(c.name)
    if (sibs) sibs.push(c)
    else byName.set(c.name, [c])
  }
  const queue = []
  for (const sibs of byName.values()) {
    sibs.sort((a, b) => String(dates.get(b.sha) ?? "").localeCompare(String(dates.get(a.sha) ?? "")))
    const [primary, ...rest] = sibs
    // Every item carries `allTips` (the verdict-check map iterates it); a
    // single-tip item's `allTips` is just itself, and `otherTips` appears
    // only when there IS an older tip (the prompt's extra section keys off it).
    primary.allTips = sibs.map(c => ({ sha: c.sha, refs: c.refs }))
    if (rest.length > 0) {
      primary.otherTips = rest.map(c => ({ sha: c.sha, refs: c.refs }))
      primary.refs = sibs.flatMap(c => c.refs)
    }
    queue.push(primary)
  }
  queue.sort(
    (a, b) =>
      (a.ageDays ?? Number.POSITIVE_INFINITY) - (b.ageDays ?? Number.POSITIVE_INFINITY) ||
      (b.residualFileCount ?? 0) - (a.residualFileCount ?? 0),
  )
  // A name is "already reviewed" only when EVERY review tip under it carries
  // a verdict — a name with one reviewed and one unreviewed tip is still
  // queued (with only the unreviewed tips).
  const pendingNames = new Set(queue.map(c => c.name))
  const fullyReviewed = new Set()
  for (const e of entries) {
    if (reviewable(e) && e.verdict && !pendingNames.has(e.name)) fullyReviewed.add(e.name)
  }
  return { queue, alreadyReviewed: fullyReviewed.size }
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

/** `error` with the per-candidate parts — its review worktree path, branch
 *  name and tip sha, then any other full sha — replaced by placeholders, so
 *  one systemic failure hitting N candidates groups as ONE reason instead of
 *  N "distinct" ones that differ only by `…/repo-<sha>`. */
export function normalizeReviewError(error, candidate) {
  let out = String(error ?? "")
  const swap = (needle, placeholder) => {
    if (typeof needle === "string" && needle.length > 0) out = out.split(needle).join(placeholder)
  }
  swap(candidate?.reviewWorktree, "<review worktree>")
  swap(candidate?.sha, "<sha>")
  swap(candidate?.name, "<branch>")
  return out.replace(/\b[0-9a-f]{40}\b/g, "<sha>")
}

/** Distinct error messages of a tolerant fan-out's rejected items (normalized
 *  by {@link normalizeReviewError} against `reviewCandidates[index]`), most
 *  frequent first: `[{ error, count }]`. */
export function tallyReviewErrors(review, reviewCandidates) {
  const counts = new Map()
  for (const r of Array.isArray(review?.results) ? review.results : []) {
    if (r?.status !== "rejected") continue
    const error = normalizeReviewError(r.error, r.item ?? reviewCandidates?.[r.index])
    counts.set(error, (counts.get(error) ?? 0) + 1)
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

/** Candidate tips from the FIRST plan that still have no recorded verdict
 *  after the review map ran — `classifyRef` (branch-gc.ts) stamps
 *  `entry.verdict` for ANY unmerged ref with a stored verdict for its exact
 *  tip sha, regardless of `includeReviewed`, so a second plan is a cheap,
 *  accurate "did every tip get reviewed" check with no separate verdict-read
 *  tool needed. A branch-name item reviews SEVERAL tips (primary +
 *  `otherTips`), so one item can yield several gaps — one per still-missing
 *  tip. A candidate the review map never started (circuit open) is not a
 *  gap — it's reported as not reviewed. */
export function computeReviewGaps(reviewCandidates, branchGcVerifyResult, review) {
  const afterEntries = branchGcVerifyResult?.plan?.entries
  const verdictShas = new Set(
    (Array.isArray(afterEntries) ? afterEntries : [])
      .filter(e => e.verdict)
      .map(e => e.sha),
  )
  const skipped = skippedShas(reviewCandidates, review)
  const gaps = []
  for (const c of reviewCandidates ?? []) {
    const refsBySha = new Map((c.allTips ?? [{ sha: c.sha }]).map(t => [t.sha, t.refs ?? c.refs]))
    for (const [sha, refs] of refsBySha) {
      if (!verdictShas.has(sha) && !skipped.has(sha)) gaps.push({ name: c.name, sha, refs })
    }
  }
  return gaps
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
  const reviewErrors = tallyReviewErrors(review, reviewCandidates)
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
  const heldVerdicts = b.input?.reviewHeldWorktrees === false ? [] : heldWorktreeVerdicts(b.steps.branchGcVerify, wtPlan)
  if (heldVerdicts.length > 0) {
    lines.push("")
    lines.push(`## Held worktrees reviewed (${heldVerdicts.length})`)
    lines.push("Idle, clean worktrees whose branch isn't provably merged — gc holds them; the reviewer's verdict says whether they can go. Removal is manual.")
    for (const v of heldVerdicts.slice(0, REPORT_LIST_CAP)) {
      lines.push(
        `- \`${v.name}\` — ${v.triage}` +
          (v.agree === true ? ` — nothing of value lost: \`agentproto worktree rm ${v.path}\`` : ` — keep (${v.path})`),
      )
    }
    if (heldVerdicts.length > REPORT_LIST_CAP) lines.push(`- … and ${heldVerdicts.length - REPORT_LIST_CAP} more`)
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
    reviewModelSmall: { type: "string", description: `Model for a review candidate with residualFileCount <= 3. Default: the \`${ROLE_REVIEW_SMALL}\` model role (repo agentproto.json \`models\` > daemon config \`models\` > built-in).` },
    reviewModelLarge: { type: "string", description: `Model for a review candidate with residualFileCount > 3, and the retry reviewer. Default: the \`${ROLE_REVIEW_LARGE}\` model role (repo agentproto.json \`models\` > daemon config \`models\` > built-in).` },
    maxReviews: { type: "number", description: `Most review candidates to review this run — newest tip first, then the larger residual. The rest are reported as not reviewed this run; tips with a stored verdict are never re-reviewed, so daily runs walk the backlog. Default ${DEFAULT_MAX_REVIEWS}.`, default: DEFAULT_MAX_REVIEWS },
    reviewHeldWorktrees: { type: "boolean", description: `Also review branches held only because they're checked out in an idle, clean linked worktree with no open PR (tip ≥ ${HELD_WORKTREE_MIN_AGE_DAYS}d old). The report lists each verdict and the removal command when the reviewer agreed; nothing is removed automatically. Default true.`, default: true },
    notify: {
      type: "object",
      description: "Optional agentpush `to` target ({ channel, address }) to notify with the report when set. Omit for no notification.",
    },
  },
  outputs: {},
  steps: [
    {
      id: "modelRoles",
      kind: "tool",
      tool: "model_roles",
      inputs: {
        repoRoot: "$input.repoRoot",
        workspaceSlug: "$input.workspaceSlug",
        roles: [ROLE_REVIEW_SMALL, ROLE_REVIEW_LARGE],
        inputs: {
          [ROLE_REVIEW_SMALL]: "$input.reviewModelSmall",
          [ROLE_REVIEW_LARGE]: "$input.reviewModelLarge",
        },
      },
    },
    {
      id: "worktreeGcPlan",
      kind: "tool",
      tool: "worktree_gc",
      // `wait: true` — without it worktree_gc returns `{ jobId, status:
      // "running" }` after its 25 s default `waitMs`, and on a repo with
      // dozens of worktrees the report would count 0 classified. branch_gc
      // already blocks by default.
      inputs: { repoRoot: "$input.repoRoot", workspaceSlug: "$input.workspaceSlug", apply: false, wait: true },
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
      compute: b => buildReviewQueue(b.steps.branchGcPlan, b.steps.worktreeGcPlan, { reviewHeldWorktrees: b.input?.reviewHeldWorktrees !== false }),
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
          model: b => reviewModel(b, (b.item?.residualFileCount ?? 0) <= 3 ? ROLE_REVIEW_SMALL : ROLE_REVIEW_LARGE),
        },
        // A reviewer can end its turn announcing calls it never made. Check
        // the store for EVERY tip of this item (the per-tip map below); if
        // any is missing, re-prompt the same session once, then retry once
        // with a fresh large-model reviewer. Only a tip still missing after
        // that is a gap (see `gaps`). Every `when` below reads the step right
        // before it — map items share one `$steps` namespace, and only the
        // immediate predecessor's value is guaranteed to be this item's.
        VERDICT_CHECK_MAP("verdictCheck"),
        VERDICT_NEEDS("needsNudge", "verdictCheck"),
        {
          id: "needsNudgeBranch",
          kind: "branch",
          branches: [{ when: "$item.verdictMissing", next: "nudge" }],
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
        VERDICT_CHECK_MAP("verdictCheckAfterNudge"),
        VERDICT_NEEDS("needsLargeRetry", "verdictCheckAfterNudge"),
        {
          id: "needsLargeRetryBranch",
          kind: "branch",
          branches: [{ when: "$item.verdictMissing", next: "reviewRetryLarge" }],
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
          model: b => reviewModel(b, ROLE_REVIEW_LARGE),
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
      id: "worktreeGcApply",
      kind: "tool",
      tool: "worktree_gc",
      inputs: {
        repoRoot: "$input.repoRoot",
        workspaceSlug: "$input.workspaceSlug",
        apply: "$input.applyMerged",
        salvageDirty: false,
        // Same as worktreeGcPlan: block for the real outcomes, or an apply
        // would run unreported in the background after the workflow ends.
        wait: true,
      },
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

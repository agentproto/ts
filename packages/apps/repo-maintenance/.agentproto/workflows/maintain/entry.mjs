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
// config `models` > preset (`reviewPreset`, else the daemon's
// `modelRolePreset`) > built-in default. The one precedence + default table
// and the presets are packages/runtime/src/model-roles.ts; nothing below
// hard-codes a model id.
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
/** The adapter `role`'s model requires (an `opencode-go/…` id only runs on
 *  opencode), as resolved by the `modelRoles` step — which folds the explicit
 *  input in too, so it always describes the model {@link reviewModel} picks.
 *  Undefined keeps the reviewer AGENT.md's own adapter. */
export function reviewAdapter(b, role) {
  return b.steps?.modelRoles?.adapters?.[role] || undefined
}
/** Named billing profile for `role` (e.g. `opencode-developerws003`), as the
 *  `modelRoles` step resolved it. Passed to the reviewer spawn as
 *  `access.profileRef`, so the reviewer bills that profile instead of the
 *  daemon's ambient credential. Undefined leaves the spawn's own default. */
export function reviewAccess(b, role) {
  const profile = b.steps?.modelRoles?.profiles?.[role]
  return profile ? { profileRef: profile } : undefined
}
/** Gateway/router `role`'s model should reach (e.g. `openrouter`), as the
 *  `modelRoles` step resolved it. Undefined keeps the model id's own route. */
export function reviewRoute(b, role) {
  return b.steps?.modelRoles?.routes?.[role] || undefined
}
/** Small model for a residual of 3 files or fewer, large otherwise. */
function reviewRole(b) {
  return (b.item?.residualFileCount ?? 0) <= 3 ? ROLE_REVIEW_SMALL : ROLE_REVIEW_LARGE
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
  "NOT provably in base are: {{item.residualFiles}}. Line coverage of what this tip adds to those " +
  "files ({ added, inBase, pct, missing: up to 12 added lines NOT verbatim in base's same path }): " +
  "{{item.lineCoverage}} — \"base has the file\" is not evidence; account for the missing lines. " +
  "`gate.agree` is your HONEST judgement about whether deleting this tip loses anything of value — " +
  "do NOT lower it because lineCoverage is under minLineCoverage. `branch_gc` applies that guard " +
  "deterministically after you: an honest agreement it refuses becomes a human decision queue item, " +
  "and self-censoring would make \"safe but guard-blocked\" indistinguishable from \"not safe\". " +
  "Merge base: {{item.mergeBase}}. Merged tree " +
  "(the tree base would have if this branch merged cleanly, or null when the merge conflicts): " +
  "{{#item.mergedTree}}{{item.mergedTree}}{{/item.mergedTree}}{{^item.mergedTree}}null{{/item.mergedTree}}. Ahead {{item.ahead}}, behind {{item.behind}}. Push state: {{item.pushed}}. " +
  "Refs of this branch (across its tips): {{item.refs}}." +
  "\n\nForge and patch evidence (the PR is read from the plan, never guessed). PR state: {{item.prSummary}}. " +
  "git cherry: {{item.cherrySummary}}. How to weigh it: a closed-unmerged PR is a strong signal the work " +
  "was abandoned or superseded, but not proof - still account for the residual files and cite what you " +
  "checked. An open PR is live work: never agree to delete it (record triage in-progress or unclear, no " +
  "gate.agree). A merged PR marked partial landed, but the branch carries commits made after it: judge " +
  "those extra commits. PR state none or unknown means no PR was found or the forge was not consulted - " +
  "do not infer one. git cherry counts commits with no patch-equivalent on base (a `+` line of `git cherry " +
  "<base> <tip>`); when it says unavailable, run that read-only command yourself. " +
  "Keep triage.reason (and gate.reason) to ONE line: the maintain report prints it verbatim next to the PR state." +
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

/** A worktree_gc plan entry's `integration` as the reviewer's PR state:
 *  `{ state: open | merged | closed-unmerged | none, number }`. `partial` is a
 *  merged PR plus commits made after it, so it is `merged` flagged `partial`
 *  (with `aheadBy`). No PR number means no PR: `none`, whatever the state. */
export function normalizePrState(integration) {
  const number = typeof integration?.pr === "number" ? integration.pr : null
  if (number === null) return { state: "none", number: null }
  switch (integration.state) {
    case "open":
    case "merged":
    case "closed-unmerged":
      return { state: integration.state, number }
    case "partial":
      return {
        state: "merged",
        number,
        partial: true,
        ...(typeof integration.aheadBy === "number" ? { aheadBy: integration.aheadBy } : {}),
      }
    default:
      return { state: "none", number: null }
  }
}

/** `closed-unmerged PR #9`, `merged PR #6 (partial: +2 commit(s) made after it)`,
 *  `none`, or `unknown` (+ ` (PR #n)` when only a number is known). */
export function formatPrState(pr) {
  const state = pr?.state ?? "unknown"
  if (state === "none" || (state === "unknown" && pr?.number == null)) return state
  if (state === "unknown") return `unknown (PR #${pr.number})`
  const partial = pr.partial ? ` (partial: ${typeof pr.aheadBy === "number" ? `+${pr.aheadBy} ` : ""}commit(s) made after it)` : ""
  return `${state} PR #${pr.number}${partial}`
}

/** `git cherry <base> <tip>` summary - `{ total, unmatched }` where `unmatched`
 *  counts the `+` lines (commits with no patch-equivalent on base). branch_gc
 *  computes it internally but does not (yet) put it on the plan entry; absent
 *  stays `unavailable`, never zero. */
export function formatCherry(cherry) {
  if (typeof cherry?.total !== "number" || typeof cherry?.unmatched !== "number") return "unavailable"
  return `${cherry.unmatched} of ${cherry.total} commit(s) have no patch-equivalent on base`
}

/** Report-line form of {@link formatCherry}: `2/5 not patch-equivalent on base`. */
function cherryShort(cherry) {
  if (typeof cherry?.total !== "number" || typeof cherry?.unmatched !== "number") return "unavailable"
  return `${cherry.unmatched}/${cherry.total} not patch-equivalent on base`
}

/** `worktree_gc` plan entry for a worktree path, or undefined. */
function worktreeEntryOf(worktreeGcPlanResult, path) {
  const entries = Array.isArray(worktreeGcPlanResult?.plan) ? worktreeGcPlanResult.plan : []
  return entries.find(w => w?.path === path)
}

/** The PR evidence for a branch_gc entry: from the matching worktree_gc entry
 *  when the branch is worktree-held (`heldPath`), else only what the branch_gc
 *  entry itself exposes (`mergedPr`, `forgePr` carry a number but not a PR
 *  state). Anything else is `unknown` - never invented. */
function prEvidenceOf(e, heldPath, worktreeGcPlanResult) {
  if (heldPath) {
    const w = worktreeEntryOf(worktreeGcPlanResult, heldPath)
    if (w?.integration) return normalizePrState(w.integration)
  }
  const number = typeof e?.mergedPr === "number" ? e.mergedPr : typeof e?.forgePr === "number" ? e.forgePr : null
  return { state: e?.mergedPr != null ? "merged" : "unknown", number }
}

/** The worktree path a branch_gc entry is held by, when that hold is the only
 *  thing between it and `review`: held for `worktree`, unmerged, old enough,
 *  and the worktree is one {@link reviewableWorktrees} kept. Else null. */
function heldWorktreeOf(e, heldWorktrees) {
  if (e?.class !== "hold" || e.holdReason !== "worktree" || e.status !== "unmerged") return null
  if ((e.ageDays ?? 0) < HELD_WORKTREE_MIN_AGE_DAYS) return null
  return heldWorktrees.get(e.holdDetail) === e.name ? e.holdDetail : null
}

/** One entry per reviewed held worktree (from the verify plan's stored
 *  verdicts): the verdict, the PR state (worktree_gc's integration) and the
 *  cherry summary (when branch_gc exposes it). {@link verdictLine} turns it
 *  into the report line - with the command that removes the worktree when
 *  the reviewer agreed nothing of value is lost. Removal stays a human step. */
export function heldWorktreeVerdicts(branchGcVerifyResult, worktreeGcPlanResult) {
  const held = reviewableWorktrees(worktreeGcPlanResult)
  const byPath = new Map()
  for (const e of branchGcVerifyResult?.plan?.entries ?? []) {
    const path = heldWorktreeOf(e, held)
    if (!path || !e.verdict || byPath.has(path)) continue
    byPath.set(path, {
      name: e.name,
      path,
      sha: e.sha,
      triage: e.verdict.triage,
      agree: e.verdict.agree ?? null,
      pr: prEvidenceOf(e, path, worktreeGcPlanResult),
      cherry: typeof e.cherry?.total === "number" && typeof e.cherry?.unmatched === "number" ? e.cherry : null,
    })
  }
  return [...byPath.values()]
}

/** `branch_gc_verdict_get` answers by tip sha, from the `verdictRecords` step
 *  (a tolerant map: `{ results: [{ status, value }] }`, or a bare array). */
export function verdictRecordsBySha(verdictRecordsStep) {
  const items = Array.isArray(verdictRecordsStep)
    ? verdictRecordsStep
    : Array.isArray(verdictRecordsStep?.results)
      ? verdictRecordsStep.results.filter(r => r?.status === "fulfilled").map(r => r.value)
      : []
  const out = new Map()
  for (const a of items) if (a?.record && typeof a.sha === "string") out.set(a.sha, a.record)
  return out
}

/** The reviewer's one-line reason from a stored verdict record
 *  (`branchVerdictSchema`): the second opinion `gate.reason` when there is
 *  one, else `triage.reason`. First line only, cut to 200 chars. */
export function verdictReason(record) {
  const raw = record?.gate?.reason ?? record?.triage?.reason
  const line = String(raw ?? "").split("\n").map(l => l.trim()).find(l => l.length > 0)
  if (!line) return "(none recorded)"
  return line.length > 200 ? `${line.slice(0, 199)}…` : line
}

/** The ONE report line for a verdict `v` (`{ name, triage, pr, cherry, path?, agree }`):
 *  branch, PR state, cherry summary, the reviewer's reason, then the action. */
export function verdictLine(v, record) {
  const head =
    `- \`${v.name}\` - ${v.triage} - PR: ${formatPrState(v.pr).replace(/ PR #(\d+)/, " #$1")}` +
    ` - cherry: ${cherryShort(v.cherry)} - reason: ${verdictReason(record)}`
  if (!v.path) return head
  // An open PR is live work: never offer its worktree for removal.
  if (v.pr?.state === "open") return `${head} - keep (open PR, ${v.path})`
  return v.agree === true ? `${head} - nothing of value lost: \`agentproto worktree rm ${v.path}\`` : `${head} - keep (${v.path})`
}

/** Tips whose stored verdict the report needs the record of (for the reason):
 *  every review candidate's tips plus the held-worktree verdicts shown. */
export function verdictLookupTips(b) {
  const shas = new Set()
  for (const c of b.steps?.reviewCandidates ?? []) {
    for (const t of c.allTips ?? [{ sha: c.sha }]) shas.add(t.sha)
  }
  if (b.input?.reviewHeldWorktrees !== false) {
    for (const v of heldWorktreeVerdicts(b.steps?.branchGcVerify, b.steps?.worktreeGcPlan).slice(0, REPORT_LIST_CAP)) shas.add(v.sha)
  }
  return [...shas].map(sha => ({ sha }))
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
      // Refs sharing a tip: keep the line coverage from whichever carries it.
      if (!seen.lineCoverage && e.lineCoverage) seen.lineCoverage = e.lineCoverage
      continue
    }
    const heldPath = heldWorktreeOf(e, heldWorktrees)
    const pr = prEvidenceOf(e, heldPath, worktreeGcPlanResult)
    const cherry = typeof e.cherry?.total === "number" && typeof e.cherry?.unmatched === "number" ? e.cherry : null
    bySha.set(e.sha, {
      name: e.name,
      kind: e.kind,
      sha: e.sha,
      ageDays: e.ageDays,
      author: e.author,
      subject: e.subject,
      history: e.history,
      pr,
      prState: pr.state,
      prNumber: pr.number,
      prSummary: formatPrState(pr),
      cherry,
      cherrySummary: formatCherry(cherry),
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
      lineCoverage: e.lineCoverage ?? null,
      refs: [e.ref],
      ...(heldPath ? { worktree: heldPath } : {}),
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

/** The coverage percentage in a `branch_gc` `verdictGuard` string
 *  (`"line coverage 80% of 50 added lines (< 95%)"`), or null when absent. */
export function lineCoveragePctOfGuard(guard) {
  const m = /line coverage\s+([\d.]+)%/i.exec(String(guard ?? ""))
  return m ? Number(m[1]) : null
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
    if (v) out.push({ name: c.name, sha: c.sha, triage: v.triage, agree: v.agree ?? null, pr: c.pr, cherry: c.cherry ?? null })
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
  const records = verdictRecordsBySha(b.steps.verdictRecords)
  const gaps = b.steps.gaps ?? []
  const verdicts = collectCandidateVerdicts(reviewCandidates, b.steps.branchGcVerify)
  const applyMerged = b.input?.applyMerged === true
  // Only meaningful with applyMerged: a dry-run never deletes either way.
  const applyReviewed = applyMerged && b.input?.applyReviewed === true
  const branchGcApply = b.steps.branchGcApply
  const worktreeGcApply = b.steps.worktreeGcApply
  const applyOutcomes = Array.isArray(branchGcApply?.outcomes) ? branchGcApply.outcomes : []
  const reclaimedReviewed = applyOutcomes.filter(o => o.result === "deleted" && o.reclaimReason === "reviewed")
  const refusedByGuard = applyOutcomes.filter(o => o.result === "refused-guard")

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
  lines.push("## Sandbox checkpoints")
  const ckPlan = b.steps.checkpointGcPlan
  const ckSummary = ckPlan?.summary
  lines.push(`- ${ckSummary?.total ?? 0} \`agentproto-checkpoint/*\` ref(s) classified`)
  lines.push(`- safe=${ckSummary?.safe ?? 0} keep=${ckSummary?.keep ?? 0} unknown=${ckSummary?.unknown ?? 0}`)
  if (ckPlan?.plan?.prCheckAvailable === false) {
    lines.push(`- PR check unavailable (${ckPlan.plan.prCheckReason ?? "unknown"}) — content tiers still applied`)
  }
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
  const heldVerdicts = b.input?.reviewHeldWorktrees === false ? [] : heldWorktreeVerdicts(b.steps.branchGcVerify, wtPlan)
  // Held worktrees get their line in their own section below.
  const heldNames = new Set(heldVerdicts.map(v => v.name))
  const branchVerdicts = verdicts.filter(v => !heldNames.has(v.name))
  if (branchVerdicts.length > 0) {
    lines.push("- verdict reasons (one line per verdict: branch, PR state, git cherry, reviewer's reason):")
    for (const v of branchVerdicts.slice(0, REPORT_LIST_CAP)) lines.push(`  ${verdictLine(v, records.get(v.sha))}`)
    if (branchVerdicts.length > REPORT_LIST_CAP) lines.push(`  - … and ${branchVerdicts.length - REPORT_LIST_CAP} more`)
  }
  if (gaps.length > 0) {
    lines.push(`- **${gaps.length} branch(es) with no recorded verdict** (after a same-session re-prompt and a large-model retry; full list in the run output's \`gaps\`): ${formatNameList(gaps.map(g => g.name))}`)
  } else if (reviewCandidates.length > 0 && reviewOutcome.skipped === 0) {
    lines.push("- every review candidate has a recorded verdict")
  }
  if (heldVerdicts.length > 0) {
    lines.push("")
    lines.push(`## Held worktrees reviewed (${heldVerdicts.length})`)
    lines.push("Idle, clean worktrees whose branch isn't provably merged — gc holds them; the reviewer's verdict says whether they can go. Removal is manual.")
    for (const v of heldVerdicts.slice(0, REPORT_LIST_CAP)) lines.push(verdictLine(v, records.get(v.sha)))
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
    const ckApply = b.steps.checkpointGcApply
    const ckCounts = ckApply?.applySummary
    lines.push(
      `- sandbox_checkpoint_gc: ${ckCounts?.deleted ?? countOutcomes(ckApply?.outcomes, "deleted")} deleted, ` +
        `${ckCounts?.skipped ?? countOutcomes(ckApply?.outcomes, "skipped-keep")} skipped, ` +
        `${ckCounts?.failed ?? countOutcomes(ckApply?.outcomes, "failed")} failed`,
    )
    if (applyReviewed) {
      lines.push(
        `- reviewed: ${reclaimedReviewed.length} reclaimed (includeReviewed true), ` +
          `${refusedByGuard.length} refused by the line-coverage guard`,
      )
    } else {
      lines.push("- only `reclaim`-class refs were touched — `includeReviewed` was false, so no reviewed-but-agreed branch was reclaimed by this run.")
    }
  }
  lines.push("")
  lines.push("## Reviewed branches")
  if (applyReviewed) {
    lines.push(
      "`applyReviewed` is true — `branch_gc` applied with `includeReviewed: true`: a `review`-class " +
        "branch was reclaimed only when its stored verdict agreed AND the deterministic line-coverage " +
        "guard (default 95%) did not refuse it.",
    )
    if (reclaimedReviewed.length > 0) {
      lines.push(`- reclaimed (${reclaimedReviewed.length}): ${formatNameList(reclaimedReviewed.map(o => o.name))}`)
    } else {
      lines.push("- reclaimed: none")
    }
    if (refusedByGuard.length > 0) {
      lines.push(
        `- reviewer agreed, refused by the line guard: ${refusedByGuard.length} — see the ` +
          "\"Human decision queue\" section below",
      )
    } else {
      lines.push("- reviewer agreed, refused by the line guard: none")
    }
  } else {
    lines.push(
      "Recording a verdict via `branch_gc_verdict` never reclaims a branch by itself, and this run " +
        "did not opt in: set `applyReviewed: true` (with `applyMerged: true`) to apply agreed verdicts. " +
        "`branch_gc` then enforces its line-coverage guard (default 95%) and refuses an approval below it.",
    )
  }
  if (applyReviewed && refusedByGuard.length > 0) {
    lines.push("")
    lines.push(`## Human decision queue — reviewer agreed, refused by line guard (${refusedByGuard.length})`)
    lines.push(
      "The reviewer's `gate.agree` was an honest safety judgement, not a policy decision. " +
        "`branch_gc` refused it deterministically because line coverage was below the guard; " +
        "these are for a human to decide, NOT evidence that the reviewer said the work was unsafe.",
    )
    for (const o of refusedByGuard.slice(0, REPORT_LIST_CAP)) {
      const pct = lineCoveragePctOfGuard(o.guard)
      lines.push(
        `- \`${o.name}\` (${o.sha.slice(0, 10)}) — ${pct !== null ? `${pct}%` : "unknown"} line coverage — ${o.guard}`,
      )
    }
    if (refusedByGuard.length > REPORT_LIST_CAP) {
      lines.push(`- … and ${refusedByGuard.length - REPORT_LIST_CAP} more`)
    }
  }
  return lines.join("\n")
}

/** The human-readable reason from a `transmit_message` rejection: its
 *  `unwrapDispatchResult` error is the tool's own JSON payload, so prefer the
 *  `error`/`blocked_reason` field over the raw string when it parses. */
function notifySkipReason(error) {
  const raw = String(error ?? "unknown")
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === "object") {
      if (typeof parsed.error === "string" && parsed.error) return parsed.error
      if (typeof parsed.blocked_reason === "string" && parsed.blocked_reason) return parsed.blocked_reason
    }
  } catch {
    // Not the tool's JSON payload — fall back to the raw message.
  }
  return raw
}

export default {
  name: "Repo Maintenance",
  id: "maintain",
  description:
    "Plan worktree_gc + branch_gc, fan a review agent out over up to " +
    "`maxReviews` unreviewed branch candidates, newest first (small model for " +
    "a small residual, large model otherwise), verify every candidate got a " +
    "verdict, optionally apply " +
    "(reclaim-only) worktree/branch gc, and report — plus an operator " +
    "notification when `notify` is set.",
  version: "0.1.0",
  inputs: {
    repoRoot: { type: "string", description: "Absolute path to the git repo. Wins over `workspaceSlug`." },
    workspaceSlug: { type: "string", description: "Workspace slug. The active workspace when both are omitted." },
    applyMerged: { type: "boolean", description: "Execute branch_gc/worktree_gc (reclaim-class only) after review. Default false.", default: false },
    applyReviewed: { type: "boolean", description: "With `applyMerged`: also reclaim `review`-class branches whose stored verdict agreed (`branch_gc` includeReviewed true). branch_gc refuses an approval below its line-coverage guard (default 95%). Default false.", default: false },
    reviewModelSmall: { type: "string", description: `Model for a review candidate with residualFileCount <= 3. Default: the \`${ROLE_REVIEW_SMALL}\` model role (repo agentproto.json \`models\` > daemon config \`models\` > built-in).` },
    reviewPreset: { type: "string", description: "Model role preset for this run (opus, sonnet, haiku, go-free, free-sonnet — see `model_roles`). Default: the daemon's `modelRolePreset`, else the built-in roles. `reviewModelSmall`/`reviewModelLarge` still win." },
    reviewModelLarge: { type: "string", description: `Model for a review candidate with residualFileCount > 3, and the retry reviewer. Default: the \`${ROLE_REVIEW_LARGE}\` model role (repo agentproto.json \`models\` > daemon config \`models\` > built-in).` },
    maxReviews: { type: "number", description: `Most review candidates to review this run — newest tip first, then the larger residual. The rest are reported as not reviewed this run; tips with a stored verdict are never re-reviewed, so daily runs walk the backlog. Default ${DEFAULT_MAX_REVIEWS}.`, default: DEFAULT_MAX_REVIEWS },
    reviewHeldWorktrees: { type: "boolean", description: `Also review branches held only because they're checked out in an idle, clean linked worktree with no open PR (tip ≥ ${HELD_WORKTREE_MIN_AGE_DAYS}d old). The report lists each verdict and the removal command when the reviewer agreed; nothing is removed automatically. Default true.`, default: true },
    notify: {
      type: "object",
      description:
        "Optional operator notification target (`{ provider?, alias?, address?, source? }`) to notify with the report when set. " +
        "Omit for no notification. `provider` defaults to `telegram` (the daemon's own bot token); `agentpush` is the only other implemented provider. " +
        "`alias` picks the imported MCP alias (agentpush) or bot-token alias (telegram). `address` is the recipient (telegram chat id / agentpush contact_ref). " +
        "`source` is agentpush's channel (required for agentpush) and is ignored by telegram. " +
        "The legacy `channel` field: `channel: telegram|agentpush` names the provider, any other value is the agentpush channel.",
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
        preset: "$input.reviewPreset",
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
      id: "checkpointGcPlan",
      kind: "tool",
      tool: "sandbox_checkpoint_gc",
      // Always a dry run: the plan classifies the stale
      // `agentproto-checkpoint/*` refs; only checkpointGcApply deletes.
      inputs: { repoRoot: "$input.repoRoot", workspaceSlug: "$input.workspaceSlug", apply: false, wait: true },
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
          model: b => reviewModel(b, reviewRole(b)),
          adapter: b => reviewAdapter(b, reviewRole(b)),
          access: b => reviewAccess(b, reviewRole(b)),
          route: b => reviewRoute(b, reviewRole(b)),
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
          adapter: b => reviewAdapter(b, ROLE_REVIEW_LARGE),
          access: b => reviewAccess(b, ROLE_REVIEW_LARGE),
          route: b => reviewRoute(b, ROLE_REVIEW_LARGE),
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
      // Stored verdict records for the report's one-line reasons: the plan
      // entry's verdict summary carries the triage verdict but not its reason.
      id: "verdictLookupTips",
      kind: "transform",
      compute: b => verdictLookupTips(b),
    },
    {
      // Cosmetic, so tolerant: a failed lookup prints "(none recorded)".
      id: "verdictRecords",
      kind: "map",
      over: "$steps.verdictLookupTips",
      parallelism: 4,
      onError: "collect",
      steps: [
        {
          id: "verdictRecordGet",
          kind: "tool",
          tool: "branch_gc_verdict_get",
          inputs: { repoRoot: "$steps.branchGcPlan.plan.repoRoot", sha: "$item.sha" },
        },
      ],
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
        // Apply the plan the review ran against, not a fresh one: worktree_gc
        // re-checks each entry (branch, HEAD, git index, live sessions) and
        // skips with a reason whatever changed while the reviewers worked.
        expectedPlan: "$steps.worktreeGcPlan.plan",
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
        includeReviewed: "$input.applyReviewed",
        scopes: ["local", "remote", "orphan"],
      },
    },
    {
      id: "checkpointGcApply",
      kind: "tool",
      tool: "sandbox_checkpoint_gc",
      // Gated exactly like the other apply steps: false ⇒ the tool plans
      // again (a dry run), true ⇒ the engine re-plans and deletes only the
      // refs it re-classifies `safe` immediately before each delete.
      inputs: {
        repoRoot: "$input.repoRoot",
        workspaceSlug: "$input.workspaceSlug",
        apply: "$input.applyMerged",
        wait: true,
      },
    },
    {
      id: "report",
      kind: "transform",
      compute: b => buildReport(b),
    },
    {
      // Build the provider-agnostic `transmit_message` input from the
      // `notify` input: `{ provider?, alias?, address?, source? }`. `provider`
      // defaults to `telegram` (the daemon's own bot-token path). `channel`
      // is accepted as a legacy alias: `channel: telegram|agentpush` names the
      // provider, while any other channel value is the agentpush destination
      // channel (the old meaning of `channel`) and selects provider
      // `agentpush`. `source` is agentpush's channel; it is never inferred
      // from `address`, and an agentpush send with no channel is skipped with
      // a reason rather than misrouted. Telegram ignores `source`. The engine
      // does not apply `inputs.*.default`, so the fallback lives here.
      // `targets` is a one-element array so the send below can be a tolerant
      // (`onError: "collect"`) map — an unconfigured provider must not fail
      // the run.
      id: "notifyPlan",
      kind: "transform",
      compute: b => {
        const configured = !!b.input?.notify
        const n = b.input?.notify ?? {}
        const address = n.address
        // `channel` is a legacy alias: `telegram`/`agentpush` name the
        // provider, so they are NOT a channel value; anything else is the
        // agentpush destination channel.
        const legacyChannel = n.channel === "telegram" || n.channel === "agentpush" ? undefined : n.channel
        const provider = n.provider || (n.channel ? (legacyChannel ? "agentpush" : n.channel) : "telegram")
        const source = n.source || (provider === "agentpush" ? legacyChannel : address)
        // Only a CONFIGURED notify target can be under-specified; with no
        // `notify` input there is simply nothing to check.
        let skipReason
        if (configured && !address) skipReason = "address required"
        else if (configured && provider === "agentpush" && !source) skipReason = "agentpush source/channel required"
        return {
          // Empty when the target is under-specified: the send is skipped
          // with a clean reason instead of failing transmit_message's schema.
          targets: skipReason ? [] : [true],
          ...(skipReason ? { skipReason } : {}),
          provider,
          alias: n.alias,
          source,
          contactRef: address,
          text: String(b.steps.report ?? "").slice(0, 3500),
        }
      },
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
      join: "reportFinal",
    },
    {
      // A notification is best-effort: `onError: "collect"` turns a rejected
      // send (unconfigured provider, missing alias, unapproved template) into
      // a recorded outcome instead of aborting the run. `reportFinal` folds
      // that outcome into the report.
      id: "notify",
      kind: "map",
      over: "$steps.notifyPlan.targets",
      parallelism: 1,
      onError: "collect",
      steps: [
        {
          id: "notifySend",
          kind: "tool",
          tool: "transmit_message",
          inputs: {
            provider: "$steps.notifyPlan.provider",
            alias: "$steps.notifyPlan.alias",
            source: "$steps.notifyPlan.source",
            contact_ref: "$steps.notifyPlan.contactRef",
            text: "$steps.notifyPlan.text",
            bind: false,
          },
        },
      ],
    },
    {
      id: "skip-notify",
      kind: "gate",
      command: "true",
    },
    {
      // Append the delivery outcome so an unconfigured/skipped provider is
      // visible in the run report instead of silently vanishing.
      id: "reportFinal",
      kind: "transform",
      compute: b => {
        const base = String(b.steps.report ?? "")
        // A target notifyPlan already knew it could not deliver (missing
        // address, agentpush with no channel) never reached transmit_message.
        // Gated on `shouldNotify`: a run that never requested a notification
        // (no `notify`, or nothing to report) must not grow a skip line.
        const planned = b.steps.notifyPlan
        if (
          b.steps.shouldNotify === true &&
          planned &&
          typeof planned === "object" &&
          typeof planned.skipReason === "string"
        ) {
          return `${base}\n\nnotify skipped: ${planned.skipReason}`
        }
        const fan = b.steps.notify
        if (!fan || typeof fan !== "object" || (fan.succeeded ?? 0) > 0) return base
        const first = Array.isArray(fan.results) ? fan.results[0] : undefined
        if (!first || first.status !== "rejected") return base
        return `${base}\n\nnotify skipped: ${notifySkipReason(first.error)}`
      },
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
    report: "$steps.reportFinal",
    gaps: "$steps.gaps",
    applyMerged: "$input.applyMerged",
    applyReviewed: "$input.applyReviewed",
    branchGcApply: "$steps.branchGcApply",
    worktreeGcApply: "$steps.worktreeGcApply",
    checkpointGcApply: "$steps.checkpointGcApply",
  },
}

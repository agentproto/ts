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

const DEFAULT_REVIEW_MODEL_SMALL = "claude-haiku-4-5-20251001"
const DEFAULT_REVIEW_MODEL_LARGE = "claude-sonnet-5"

/** One `review`-class branch_gc plan entry per unique tip sha — a local
 *  branch and its remote twin share a tip, so they share one review instead
 *  of costing the reviewer two turns. Mirrors `branchReviewQueue()`
 *  (`packages/worktree/src/branch-gc.ts`), reimplemented here because that
 *  function isn't exposed through the `branch_gc` MCP tool (only the CLI's
 *  `review-queue` subcommand calls it directly). */
function dedupeReviewCandidates(branchGcPlanResult) {
  const plan = branchGcPlanResult?.plan
  const entries = Array.isArray(plan?.entries) ? plan.entries : []
  const bySha = new Map()
  for (const e of entries) {
    if (e.class !== "review") continue
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
      compareBase: e.compareBase ?? null,
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
  return [...bySha.values()]
}

/** Candidates from the FIRST plan that still have no recorded verdict after
 *  the review map ran — `classifyRef` (branch-gc.ts) stamps `entry.verdict`
 *  for ANY unmerged ref with a stored verdict for its exact tip sha,
 *  regardless of `includeReviewed`, so a second plan is a cheap, accurate
 *  "did every candidate get reviewed" check with no separate verdict-read
 *  tool needed. */
function computeReviewGaps(reviewCandidates, branchGcVerifyResult) {
  const afterEntries = branchGcVerifyResult?.plan?.entries
  const verdictShas = new Set(
    (Array.isArray(afterEntries) ? afterEntries : [])
      .filter(e => e.verdict)
      .map(e => e.sha),
  )
  return (reviewCandidates ?? [])
    .filter(c => !verdictShas.has(c.sha))
    .map(c => ({ name: c.name, sha: c.sha, refs: c.refs }))
}

function countOutcomes(outcomes, result) {
  return (Array.isArray(outcomes) ? outcomes : []).filter(o => o.result === result).length
}

function buildReport(b) {
  const wtPlan = b.steps.worktreeGcPlan
  const bgPlan = b.steps.branchGcPlan
  const plan = bgPlan?.plan
  const summary = bgPlan?.summary
  const reviewCandidates = b.steps.reviewCandidates ?? []
  const review = b.steps.review
  const reviewOutcome = Array.isArray(review)
    ? { succeeded: review.length, failed: 0 }
    : review ?? { succeeded: 0, failed: 0 }
  const gaps = b.steps.gaps ?? []
  const applyMerged = b.input?.applyMerged === true
  const branchGcApply = b.steps.branchGcApply
  const worktreeGcApply = b.steps.worktreeGcApply

  const lines = []
  lines.push(`# Repo maintenance — ${plan?.repoName ?? plan?.repoRoot ?? "unknown repo"}`)
  lines.push("")
  lines.push(`Base \`${plan?.base ?? "?"}\` @ \`${(plan?.baseSha ?? "").slice(0, 10)}\`${plan?.anchor ? ` (anchor \`${plan.anchor.slice(0, 10)}\`)` : ""}`)
  lines.push("")
  lines.push("## Worktrees")
  const wtOutcomes = Array.isArray(wtPlan?.outcomes) ? wtPlan.outcomes : wtPlan?.plan?.worktrees ?? []
  lines.push(`- mode: \`${wtPlan?.mode ?? "plan"}\` — ${Array.isArray(wtOutcomes) ? wtOutcomes.length : 0} worktree(s) classified`)
  lines.push("")
  lines.push("## Branches")
  for (const kind of plan?.scopes ?? []) {
    const c = summary?.byClass?.[kind]
    if (!c) continue
    lines.push(`- **${kind}**: reclaim=${c.reclaim} review=${c.review} hold=${c.hold}`)
  }
  if (plan?.otherRemoteRefs) lines.push(`- (${plan.otherRemoteRefs} ref(s) of other configured remotes left alone)`)
  lines.push("")
  lines.push(`## Review (${reviewCandidates.length} candidate(s))`)
  lines.push(`- reviewer agent turns: ${reviewOutcome.succeeded} ok, ${reviewOutcome.failed} failed`)
  if (gaps.length > 0) {
    lines.push(`- **${gaps.length} branch(es) with no recorded verdict**: ${gaps.map(g => g.name).join(", ")}`)
  } else if (reviewCandidates.length > 0) {
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
    lines.push(`- worktree_gc: ${Array.isArray(worktreeGcApply?.outcomes) ? worktreeGcApply.outcomes.length : 0} outcome(s)`)
    lines.push("- only `reclaim`-class refs were touched — `includeReviewed` was false, so no reviewed-but-agreed branch was reclaimed by this run.")
  }
  lines.push("")
  lines.push("## approve-reviewed (documented seam, not wired)")
  lines.push(
    "Recording a verdict via `branch_gc_verdict` never reclaims a branch by itself. " +
      "A human-in-the-loop gate that reclaims `review`-class branches whose stored " +
      "verdict agreed (`branch_gc`'s `includeReviewed: true`) is a deliberate, " +
      "documented seam — not built here. See PLAN.md's \"OUT OF SCOPE: the approval gate\".",
  )
  return lines.join("\n")
}

export default {
  name: "Repo Maintenance",
  id: "maintain",
  description:
    "Plan worktree_gc + branch_gc, fan a review agent out over every unmerged " +
    "branch candidate (small model for a small residual, large model " +
    "otherwise), verify every candidate got a verdict, optionally apply " +
    "(reclaim-only) worktree/branch gc, and report — plus an agentpush " +
    "notification when `notify` is set.",
  version: "0.1.0",
  inputs: {
    repoRoot: { type: "string", description: "Absolute path to the git repo. Wins over `workspaceSlug`." },
    workspaceSlug: { type: "string", description: "Workspace slug. The active workspace when both are omitted." },
    applyMerged: { type: "boolean", description: "Execute branch_gc/worktree_gc (reclaim-class only) after review. Default false.", default: false },
    reviewModelSmall: { type: "string", description: `Model for a review candidate with residualFileCount <= 3. Default ${DEFAULT_REVIEW_MODEL_SMALL}.`, default: DEFAULT_REVIEW_MODEL_SMALL },
    reviewModelLarge: { type: "string", description: `Model for a review candidate with residualFileCount > 3. Default ${DEFAULT_REVIEW_MODEL_LARGE}.`, default: DEFAULT_REVIEW_MODEL_LARGE },
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
      id: "reviewCandidates",
      kind: "transform",
      compute: b => dedupeReviewCandidates(b.steps.branchGcPlan),
    },
    {
      id: "review",
      kind: "map",
      over: "$steps.reviewCandidates",
      parallelism: 4,
      onError: "collect",
      steps: [
        {
          id: "reviewOne",
          kind: "agent",
          agent: { ref: "@agentproto/repo-maintenance-reviewer" },
          prompt:
            "Review the {{item.kind}} branch `{{item.name}}` (tip {{item.sha}}) in the repo at " +
            "{{steps.branchGcPlan.plan.repoRoot}}. It is unmerged relative to base " +
            "{{steps.branchGcPlan.plan.base}} (base sha {{item.base}})" +
            "{{#item.compareBase}}, compare base {{item.compareBase}} (pre-rewrite history — commit " +
            "shas from that history do not exist on the current base; compare CONTENT, not shas){{/item.compareBase}}. " +
            "\n\nCoverage already proved what's in base by content: {{item.coverage}}. The residual files " +
            "NOT provably in base are: {{item.residualFiles}}. Merge base: {{item.mergeBase}}. Merged tree " +
            "(the tree base would have if this branch merged cleanly, or null when the merge conflicts): " +
            "{{item.mergedTree}}. Ahead {{item.ahead}}, behind {{item.behind}}. Push state: {{item.pushed}}. " +
            "Every ref sharing this tip: {{item.refs}}." +
            "\n\nRecord your verdict by calling branch_gc_verdict with repoRoot=" +
            "\"{{steps.branchGcPlan.plan.repoRoot}}\", name=\"{{item.name}}\", sha=\"{{item.sha}}\", " +
            "a triage block, and — ONLY when you agree deleting this branch loses nothing of value — a " +
            "gate block with agree:true and non-empty evidence. Call branch_gc_verdict exactly once for " +
            "this branch, then stop.",
          model: b => ((b.item?.residualFileCount ?? 0) <= 3
            ? (b.input?.reviewModelSmall || DEFAULT_REVIEW_MODEL_SMALL)
            : (b.input?.reviewModelLarge || DEFAULT_REVIEW_MODEL_LARGE)),
        },
      ],
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
      compute: b => computeReviewGaps(b.steps.reviewCandidates, b.steps.branchGcVerify),
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
  result: {
    report: "$steps.report",
    gaps: "$steps.gaps",
    applyMerged: "$input.applyMerged",
    branchGcApply: "$steps.branchGcApply",
    worktreeGcApply: "$steps.worktreeGcApply",
  },
}

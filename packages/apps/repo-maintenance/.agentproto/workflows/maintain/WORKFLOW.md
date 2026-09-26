---
name: Repo Maintenance
id: maintain
description: >-
  Plan worktree_gc + branch_gc, fan a review agent out over up to
  `maxReviews` unreviewed branch candidates, newest first (small model for a
  small residual, large model otherwise), verify every candidate got a verdict, optionally apply
  (reclaim-only) worktree/branch gc, and report — plus an agentpush
  notification when `notify` is set. Entry-based (see entry.mjs): the
  `review` map step's per-candidate model selector is a real run-time
  function, which the pure-.md path cannot express (`defineWorkflow` rejects
  a non-string `model` — "a run-time selector is only available on the
  TS-authored runtime step").
version: 0.1.0
entry: ./entry.mjs
inputs:
  repoRoot:
    type: string
    description: Absolute path to the git repo. Wins over `workspaceSlug`.
  workspaceSlug:
    type: string
    description: Workspace slug. The active workspace when both are omitted.
  applyMerged:
    type: boolean
    description: Execute branch_gc/worktree_gc (reclaim-class only) after review.
    default: false
  reviewModelSmall:
    type: string
    description: Model for a review candidate with residualFileCount <= 3.
    default: claude-haiku-4-5-20251001
  reviewModelLarge:
    type: string
    description: Model for a review candidate with residualFileCount > 3.
    default: claude-sonnet-5
  maxReviews:
    type: number
    description: >-
      Most review candidates to review this run — newest tip first, then the
      larger residual. The rest are reported as not reviewed this run; tips
      with a stored verdict are never re-reviewed, so daily runs walk the
      backlog.
    default: 40
  notify:
    type: object
    description: >-
      Optional agentpush `to` target ({ channel, address }) to notify with
      the report when set. Omit for no notification.
outputs: {}
steps:
  - id: worktreeGcPlan
    kind: tool
    name: Plan worktree gc
    tool: worktree_gc
    inputs:
      repoRoot: $input.repoRoot
      workspaceSlug: $input.workspaceSlug
      apply: false

  - id: branchGcPlan
    kind: tool
    name: Plan branch gc
    tool: branch_gc
    inputs:
      repoRoot: $input.repoRoot
      workspaceSlug: $input.workspaceSlug
      apply: false
      includeReviewed: false

  - id: reviewQueue
    kind: transform
    name: Queue unreviewed review candidates, one per tip sha
    description: >-
      Entry-based — no string expression language for `compute` in the
      declarative manifest. See entry.mjs's buildReviewQueue: dedupes by tip
      sha, skips tips that already carry a stored verdict, and orders newest
      tip first, then the larger residual.

  - id: reviewCandidates
    kind: transform
    name: Take this run's share of the queue
    description: Entry-based — the first `maxReviews` of reviewQueue.

  - id: reviewWorktreePaths
    kind: transform
    name: Name each candidate's disposable review worktree
    description: >-
      Entry-based. Every candidate carries `reviewWorktree`, a detached
      worktree path under the OS tmp dir (`agentproto-maintain-review/`),
      never the live checkout. This step lists them for the cleanups.

  - id: review
    kind: map
    name: Review every unmerged candidate
    description: >-
      One reviewer-agent turn per unique tip sha, parallelism 4. Model is
      picked per item by entry.mjs: haiku when residualFileCount <= 3, else
      sonnet. The agent records its verdict via branch_gc_verdict — this
      step never applies anything. After the turn, branch_gc_verdict_get
      checks the store for that tip; with no verdict, the SAME session is
      re-prompted once, then one fresh large-model reviewer retries, and
      only then is the tip left as a gap. Each item first creates its own
      detached review worktree of the tip (`branch_gc_review_worktree`),
      runs its reviewers there — never in the live checkout — and removes it
      last. Three spawn
      failures in a row open the engine's circuit breaker: the remaining
      candidates are not started and are reported as not reviewed. See
      entry.mjs for the body.
    over: $steps.reviewCandidates
    parallelism: 4
    onError: collect
    steps:
      - id: reviewOne
        kind: agent
        agent:
          ref: "@agentproto/repo-maintenance-reviewer"
        prompt: See entry.mjs — mustache-templated over $item + branchGcPlan.

  - id: reviewCleanup
    kind: tool
    name: Remove every review worktree
    description: >-
      An item that failed never reached its own removal — clear them all
      before anything re-plans or gc's worktrees. The entry's `finally`
      block runs the same removal again whatever happens (failure, cancel).
    tool: branch_gc_review_worktree
    inputs:
      repoRoot: $steps.branchGcPlan.plan.repoRoot
      action: remove
      paths: $steps.reviewWorktreePaths

  - id: branchGcVerify
    kind: tool
    name: Re-plan to pick up recorded verdicts
    tool: branch_gc
    inputs:
      repoRoot: $input.repoRoot
      workspaceSlug: $input.workspaceSlug
      apply: false
      includeReviewed: false

  - id: gaps
    kind: transform
    name: Review candidates with no recorded verdict
    description: Entry-based — see entry.mjs's computeReviewGaps.

  - id: branchGcApply
    kind: tool
    name: Apply branch gc (reclaim only)
    description: >-
      `apply` is $input.applyMerged — a dry-run plan again when false.
      `includeReviewed` stays false: this workflow never reclaims a
      review-class branch, even an agreed one (see the approve-reviewed
      seam below).
    tool: branch_gc
    inputs:
      repoRoot: $input.repoRoot
      workspaceSlug: $input.workspaceSlug
      apply: $input.applyMerged
      includeReviewed: false
      scopes: [local, remote, orphan]

  - id: worktreeGcApply
    kind: tool
    name: Apply worktree gc
    tool: worktree_gc
    inputs:
      repoRoot: $input.repoRoot
      workspaceSlug: $input.workspaceSlug
      apply: $input.applyMerged
      salvageDirty: false

  - id: report
    kind: transform
    name: Build the markdown summary
    description: Entry-based — see entry.mjs's buildReport.

  - id: notifyBody
    kind: transform
    name: Format the agentpush notification body
    description: Entry-based — turns the report into agentpush's send_message JSON body.

  - id: shouldNotify
    kind: transform
    name: Decide whether there's anything worth notifying about
    description: >-
      Entry-based — true only when `notify` is set AND there's a
      reclaimable ref or a review candidate. A clean plan-only sweep
      shouldn't page anyone.

  - id: maybeNotify
    kind: branch
    name: Notify only when shouldNotify is true
    branches:
      - when: $steps.shouldNotify
        next: notify
    default: skip-notify

  - id: notify
    kind: tool
    name: Send the agentpush notification
    tool: command_execute
    inputs:
      command: bash
      args:
        - "-c"
        - >-
          curl -s --max-time 30 -X POST -H "Authorization: Bearer
          ${AGENTPUSH_API_KEY:-}" -H "Content-Type: application/json"
          https://api.agentpush.io/tools/send_message --data-binary @-
      stdin: $steps.notifyBody

  - id: skip-notify
    kind: gate
    name: No notification requested
    command: "true"

result:
  report: $steps.report
  gaps: $steps.gaps
  applyMerged: $input.applyMerged
  branchGcApply: $steps.branchGcApply
  worktreeGcApply: $steps.worktreeGcApply
---

# Repo Maintenance — `maintain` workflow

`worktree_gc` + `branch_gc` plan → fan a reviewer agent out over every
unmerged branch (small model for a small residual, large model otherwise) →
verify every candidate got a verdict → optionally apply (reclaim-class only)
→ markdown report, plus an agentpush notification when `notify` is set.

Entry-based (`entry.mjs`) for one reason: `review`'s per-candidate `model`
selector is a real run-time function, which only the entry-loader path can
carry (see the description above and entry.mjs's own docblock).

## Review worktrees

Reviewers never run in the live checkout. Each review item creates a
disposable DETACHED worktree of the tip under review under the OS tmp dir
(`branch_gc_review_worktree`, which refuses any other location) and removes
it when the item ends; `reviewCleanup` removes them all after the map, and
entry.mjs's `finally` block removes them once more on failure or cancel — a
`finally` step always runs.

## Out of scope, on purpose

Recording a verdict via `branch_gc_verdict` never reclaims a branch by
itself — `branchGcApply` always runs with `includeReviewed: false`. A
human-in-the-loop gate that reclaims `review`-class branches whose stored
verdict agreed is a documented, unwired seam (`approve-reviewed`), not built
here — see the app README, "Out of scope: the approval gate".

## Enabling

`command_execute` (the `notify` step) needs `bash` allowlisted in the
workspace's `.agentproto/allowed-commands.json`, and `AGENTPUSH_API_KEY` set
in the daemon's environment, before passing a `notify` input.

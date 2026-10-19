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
  applyReviewed:
    type: boolean
    description: >-
      With `applyMerged`: also reclaim `review`-class branches whose stored
      verdict agreed (`branch_gc` includeReviewed true). branch_gc refuses an
      approval below its line-coverage guard (default 95%). Default false.
    default: false
  reviewModelSmall:
    type: string
    description: >-
      Model for a review candidate with residualFileCount <= 3. Default: the
      `review.small` model role (repo agentproto.json `models` > daemon config
      `models` > built-in).
  reviewPreset:
    type: string
    description: >-
      Model role preset for this run (opus, sonnet, haiku, go-free,
      free-sonnet — see `model_roles`). Default: the daemon's
      `modelRolePreset`, else the built-in roles. `reviewModelSmall` /
      `reviewModelLarge` still win. Each reviewer spawns on the adapter its
      model requires (an `opencode-go/…` model runs on opencode).
  reviewModelLarge:
    type: string
    description: >-
      Model for a review candidate with residualFileCount > 3, and the retry
      reviewer. Default: the `review.large` model role (repo agentproto.json
      `models` > daemon config `models` > built-in).
  maxReviews:
    type: number
    description: >-
      Most review candidates to review this run — newest tip first, then the
      larger residual. The rest are reported as not reviewed this run; tips
      with a stored verdict are never re-reviewed, so daily runs walk the
      backlog.
    default: 40
  reviewHeldWorktrees:
    type: boolean
    description: >-
      Also review branches held only because they're checked out in an idle,
      clean linked worktree with no open PR (tip at least 3 days old). The
      report lists each verdict and the removal command when the reviewer
      agreed; nothing is removed automatically.
    default: true
  notify:
    type: object
    description: >-
      Optional agentpush `to` target ({ channel, address }) to notify with
      the report when set. Omit for no notification.
  notifyAlias:
    type: string
    description: Imported MCP alias used to send the notification.
    default: agentpush
outputs: {}
steps:
  - id: modelRoles
    kind: tool
    name: Resolve the reviewer model roles
    tool: model_roles
    inputs:
      repoRoot: $input.repoRoot
      workspaceSlug: $input.workspaceSlug
      roles:
        - review.small
        - review.large
      inputs:
        review.small: $input.reviewModelSmall
        review.large: $input.reviewModelLarge

  - id: worktreeGcPlan
    kind: tool
    name: Plan worktree gc
    description: >-
      `wait: true` — without it worktree_gc falls back to a background job
      after 25 s and returns a bare jobId instead of the plan.
    tool: worktree_gc
    inputs:
      repoRoot: $input.repoRoot
      workspaceSlug: $input.workspaceSlug
      apply: false
      wait: true

  - id: branchGcPlan
    kind: tool
    name: Plan branch gc
    tool: branch_gc
    inputs:
      repoRoot: $input.repoRoot
      workspaceSlug: $input.workspaceSlug
      apply: false
      includeReviewed: false

  - id: checkpointGcPlan
    kind: tool
    name: Plan sandbox checkpoint gc
    description: >-
      Always a dry run: classifies the stale `agentproto-checkpoint/*` refs a
      dead sandbox left on the remote as safe / keep / unknown.
    tool: sandbox_checkpoint_gc
    inputs:
      repoRoot: $input.repoRoot
      workspaceSlug: $input.workspaceSlug
      apply: false
      wait: true

  - id: reviewQueue
    kind: transform
    name: Queue unreviewed review candidates, one per branch name
    description: >-
      Entry-based — no string expression language for `compute` in the
      declarative manifest. With `reviewHeldWorktrees` (default true) it also
      queues branches branch_gc held only for `worktree` when worktreeGcPlan
      shows that worktree idle, clean and without an open PR (entry.mjs's
      reviewableWorktrees). See entry.mjs's buildReviewQueue: dedupes by tip
      sha, then merges candidates whose refs share one branch name (a local
      branch and its remote twin review together even when their tips
      diverged — the newest tip is primary, the older ones ride along as
      otherTips), skips names whose every tip already carries a stored
      verdict, and orders oldest first, then the larger residual.

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
    name: Review every unmerged branch
    description: >-
      One reviewer-agent turn per branch name, parallelism 4. Model is
      picked per item by entry.mjs: sonnet when residualFileCount <= 3, else
      opus (the `review.small` / `review.large` model roles). The agent records its verdict via branch_gc_verdict — one call
      PER tip the item carries (an item may hold a local + a remote tip that
      diverged); this step never applies anything. After the turn,
      branch_gc_verdict_get checks the store for EVERY tip; with any
      verdict missing, the SAME session is re-prompted once, then one fresh
      large-model reviewer retries, and only then are the still-missing tips
      left as gaps. Each item first creates its own
      detached review worktree of the primary tip (`branch_gc_review_worktree`),
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

  - id: worktreeGcApply
    kind: tool
    name: Apply worktree gc
    tool: worktree_gc
    inputs:
      repoRoot: $input.repoRoot
      workspaceSlug: $input.workspaceSlug
      apply: $input.applyMerged
      salvageDirty: false
      wait: true

  - id: branchGcApply
    kind: tool
    name: Apply branch gc (reclaim only unless applyReviewed)
    description: >-
      `apply` is $input.applyMerged — a dry-run plan again when false.
      `includeReviewed` is $input.applyReviewed: only with `applyMerged` and
      `applyReviewed` true does an agreed `review`-class verdict get applied,
      and branch_gc's line-coverage guard (default 95%) can still refuse it.
    tool: branch_gc
    inputs:
      repoRoot: $input.repoRoot
      workspaceSlug: $input.workspaceSlug
      apply: $input.applyMerged
      includeReviewed: $input.applyReviewed
      scopes: [local, remote, orphan]

  - id: checkpointGcApply
    kind: tool
    name: Apply sandbox checkpoint gc
    description: >-
      `apply` is $input.applyMerged — a dry-run plan again when false. On
      apply the engine re-plans and re-classifies every ref immediately
      before deleting it, so a stale plan never deletes changed work.
    tool: sandbox_checkpoint_gc
    inputs:
      repoRoot: $input.repoRoot
      workspaceSlug: $input.workspaceSlug
      apply: $input.applyMerged
      wait: true

  - id: report
    kind: transform
    name: Build the markdown summary
    description: Entry-based — see entry.mjs's buildReport.

  - id: notifyBody
    kind: transform
    name: Format the agentpush notification body
    description: Entry-based — turns the report into agentpush's send_message arguments object.

  - id: notifyAlias
    kind: transform
    name: Resolve the imported MCP alias
    description: >-
      Entry-based — `notifyAlias` when set, else `agentpush`. The engine does
      not apply `inputs.*.default`, so the fallback lives in entry.mjs.

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
    description: >-
      Calls the operator's imported agentpush MCP through
      `mcp_imported_call` — the alias is `notifyAlias` (default `agentpush`).
    tool: mcp_imported_call
    inputs:
      alias: $steps.notifyAlias
      toolName: send_message
      args: $steps.notifyBody

  - id: skip-notify
    kind: gate
    name: No notification requested
    command: "true"

result:
  report: $steps.report
  gaps: $steps.gaps
  applyMerged: $input.applyMerged
  applyReviewed: $input.applyReviewed
  branchGcApply: $steps.branchGcApply
  worktreeGcApply: $steps.worktreeGcApply
  checkpointGcApply: $steps.checkpointGcApply
---

# Repo Maintenance — `maintain` workflow

`worktree_gc` + `branch_gc` + `sandbox_checkpoint_gc` plan → fan a reviewer
agent out over every unmerged branch (small model for a small residual, large
model otherwise) → verify every candidate got a verdict → optionally apply
(reclaim-class only) → markdown report, plus an agentpush notification when
`notify` is set.

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

A review worktree sits outside every app zone, so a reviewer spawned there
gets two extra READ-ONLY zones for its own session: the worktree and the
repo's git dir (`git log/show/diff` read the object store). Both are checked
against git's own worktree back-pointer first, and both are read-only, so a
reviewer still cannot stash, checkout or commit in the shared repo.

## Applying agreed verdicts

Recording a verdict via `branch_gc_verdict` never reclaims a branch by
itself. An opt-in `applyReviewed: true` (only meaningful together with
`applyMerged: true`) runs `branchGcApply` with `includeReviewed: true`, so a
`review`-class branch whose stored verdict agreed for the SAME tip can be
reclaimed. `branch_gc` itself still enforces the deterministic line-coverage
guard (default 95%): an approval below it is refused (`refused-guard`) and
the branch stays. The report lists both the reclaimed reviewed branches and
the approvals the guard refused. Default false — see the app README,
"Applying agreed verdicts".

## Enabling

The `notify` step sends through the operator's imported agentpush MCP:
`mcp_imported_call` with the alias named by `notifyAlias` (default
`agentpush`) and `toolName: "send_message"`. No `bash` allowlist entry and no
`AGENTPUSH_API_KEY` in the daemon environment are needed — just the imported
agentpush MCP that every other routine already uses. If the imported server
lives under a different alias, set `notifyAlias`.

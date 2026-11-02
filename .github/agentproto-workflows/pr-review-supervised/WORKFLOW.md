---
name: Agentproto PR Review (supervised)
id: agentproto-pr-review-supervised
description: >
  ONE supervised review loop: review, then (when changes are requested) fix
  the working tree and re-review, bounded by maxFixIterations from
  .github/agentic-review.json. The reviewer and fixer run on the CI checkout
  as children of the supervisor session the runner passes in, so the check
  run can show every stage and its verdict.
version: 0.1.0
entry: ./entry.mjs
inputs:
  prNumber:
    type: number
    description: The pull request number to review.
    default: 0
  baseRef:
    type: string
    description: Base branch ref (e.g. "main").
    default: main
  repo:
    type: string
    description: owner/repo slug.
    default: ""
  lastReviewedSha:
    type: string
    description: SHA the reviewer last posted a review against; empty on first review.
    default: ""
  priorReviewBody:
    type: string
    description: The markdown body of the reviewer's prior review, for continuity.
    default: ""
  githubToken:
    type: string
    description: GitHub token for posting reviews and changesets.
  anthropicApiKey:
    type: string
    description: Fallback API key (unused by this workflow).
  reviewConfig:
    type: object
    description: Parsed .github/agentic-review.json config.
outputs:
  conclusion:
    type: string
    description: approved | changes_requested | comment
  reviewBody:
    type: string
    description: The markdown review body posted.
  changesetWritten:
    type: boolean
    description: Whether a changeset was written.
  error:
    type: string
    description: Error message if the review failed.
steps:
  - id: supervised-review
    kind: loop
  - id: needs-final-review
    kind: branch
  - id: review
    kind: agent
---

# Agentproto PR Review (supervised)

One agentflow that carries the whole review/fix/re-review cycle inside a
single supervised workflow run, instead of two GitHub Actions jobs that can
never share a run (`pr-review`, then `pr-fix` only on `CHANGES_REQUESTED`).

The manifest above mirrors the entry's top-level step graph for governance
(AIP-15 `reconcileEntry`); `entry.mjs` is the source of truth for the nested
steps and the runtime `agent` steps.

## Flow

```
review ─▶ changes requested? ─▶ fix ─▶ re-review ─┐
   ▲                                              │
   └──────────── until approved ─────────────────┘
              (bounded by maxFixIterations)
```

1. **review** - a host `gh`-authenticated session reads
   `git diff origin/<baseRef>...HEAD`, posts ONE structured review, writes a
   changeset on the first pass, then ends its turn with a JSON verdict
   (`{ conclusion, summary, findings }`). The step declares that JSON as its
   `outputSchema`, so the loop branches on a typed step output, never on prose.
2. **needs-fix** - a `branch` step: only a `request_changes` verdict enters
   the fixer arm. `approve` leaves the body immediately.
3. **fix** - a host session applies the minimal edits for the prior verdict's
   findings. It only writes the WORKING TREE: no commit, no push, no PR, no
   review. This is `fixDelivery: "commit"` - the calling job commits and
   pushes after the run.
4. **re-review** - the loop re-runs `review`, which now also inspects
   `git diff` / `git status --porcelain` so it sees the fixer's uncommitted
   edits. It posts a fresh review and a fresh verdict; approve exits, another
   request_changes fixes again.
5. **final review** - when the loop exhausts its budget without approving, a
   trailing review-only branch runs ONE last `review` so the last fix is
   always re-reviewed. It is skipped when the loop already approved.

`max_iterations` is `maxFixIterations` (read from
`.github/agentic-review.json` at load time). Each iteration is one review plus
at most one fix round, so the run performs at most `maxFixIterations` fixes, and
`maxFixIterations + 1` reviews in the non-converging case (the trailing pass).
`maxFixIterations: 0` is a review-only run.

Known limitation: the approving review is posted before the calling job commits
and pushes the fix, so it attaches to the pre-fix HEAD. With "dismiss stale
approvals" enabled, the pushed fix needs its own review on the next CI run; the
loop still converges across runs, and `fixDelivery: "commit"` stays intact.

## Supervisor / children

The runner (`agentproto-run`) spawns an idle **supervisor** session and passes
its id as `supervisorSessionId` to `workflow_run_file`. Every step session the
run spawns records that id as its `parentSessionId`, so the reviewer and fixer
are real children of one supervisor in the sessions tree (non-empty
`parentSessionId`), not anonymous roots.

## Check run

The driver folds the run's executed steps into a title + markdown summary
(`scripts/lib/review-run-summary.mjs`): the stage diagram, one row per
review/fix step with its verdict, and the final verdict. It writes that to the
job's step summary and the `pr-review` job posts it as a check run, so stages
are visible even when they exist.

## Host placement

Both agent steps run on the CI checkout, NOT in an e2b/computer box. The
fixer must write the job's working tree (`fixDelivery: "commit"`), and a
re-review in a fresh box would clone `pull/<n>/head` and never see those
uncommitted edits. The fixer lane already runs on the host, so this reuses
that proven spawn path.

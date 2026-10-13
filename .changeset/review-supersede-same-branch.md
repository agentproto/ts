---
"@agentproto/runtime": patch
---

Fix: `review_run({supersede: true})` no longer cancels a stacked sibling branch's review

- `supersedeStale` in `packages/runtime/src/review-runner.ts` used to cancel
  any in-flight run with the same repo + binding + base whose head was an
  ancestor of the new run's head, regardless of branch. A stacked branch
  (e.g. `wt/p2` built on top of `wt/p1`) pushed from another worktree would
  then cancel `wt/p1`'s own in-flight review even though `p1` was never
  re-pushed, because `p1`'s head is trivially an ancestor of `p2`'s head.
- Ancestry now only counts toward "same line of work" when both runs also
  share the same branch name — the intended case (a re-push of the same
  branch from a re-provisioned/another worktree after amend/fixup) still
  supersedes; same-checkout re-runs still always supersede regardless of
  branch; a detached `HEAD` only matches its own checkout.
- Added `ReviewRun.branch` (the branch resolved in `repoRoot` when the range
  resolves; `undefined` on detached `HEAD`) and updated the `supersede` doc
  comments in `review-runner.ts`, the `review_run` tool description in
  `review-tools.ts`, and `docs/cli/verbs/review.md`.

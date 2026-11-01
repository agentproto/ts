---
"@agentproto/worktree": minor
"@agentproto/runtime": minor
"@agentproto/cli": patch
---

branch gc: a branch whose work landed through a merged PR is now `pr-merged` (reclaim) even when its tip is not that PR's exact head. Two new deterministic matches, both read from one `git log --stdin` over every merged PR head that is present locally: `ancestor` (the tip is an ancestor of a merged PR's head, the PR kept going after the branch stopped) and `patch` (every non-merge commit of the tip has a patch-equivalent commit, same `git patch-id --stable` and same author time and email, in some merged PR's history, so a rebased branch or one whose commits landed across stacked PRs matches). Entries carry `mergedPrMatch` (`head`, `ancestor` or `patch`) next to `mergedPr`. Before, these branches sat in the review class, where the line-coverage guard refused their agreeing verdicts. The plan still never fetches: a merged PR head missing from the object database offers no match.

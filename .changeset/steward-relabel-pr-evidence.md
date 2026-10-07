---
"@agentproto/apps": patch
"@agentproto/runtime": patch
---

session-steward: the "terminal sessions missing an outcome" proposals now use real evidence instead of always falling back to `abandoned`. A session whose list row records an opened PR (`openedPrs` / `outcome.artifacts`) is proposed `done` with the PR in the reason (`PR #1738 merged`, `PRs #1738, #1740 opened`); a merged worktree/PR or an open PR seen through `session_evidence` is proposed `done` too. That lookup runs only for the newest 20 listed sessions; the rest stay `abandoned`.

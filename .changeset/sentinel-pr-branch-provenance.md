---
"@agentproto/runtime": patch
---

Surface the PR's head branch name (`headRefName`) in `review_pr`'s status
snapshot and in `local-gh` sentinel events, so a watching session can read
who opened a PR directly from the event's `data` instead of GitHub's
`author` field — which is always the same bot account for every PR we open,
and so cannot distinguish which agent/role opened it. The branch's own
prefix convention (`pm-brain/...`, `mainteneur/...`, `fix-pr-<n>-...`) does.

---
"@agentproto/runtime": patch
---

Session steward: a session whose last turn errored is no longer auto-closed (it goes to the judge); relabel proposes `unknown` instead of `abandoned` when no PR is recorded, and no longer credits a session with a sibling worktree's merged PR; loop detection no longer collapses arg-less in-agent calls into one signature and reads the file after the read verb rather than a leading `cd` path.

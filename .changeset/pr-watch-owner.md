---
"@agentproto/sentinel": minor
"@agentproto/runtime": minor
---

One owner rule for PR watches: the auto-linked `auto:pr#N` sentinel now reaches the session the PR was recorded on AND that session's live parent (the supervisor), so a supervisor that opens a PR for an executor, or a reconciler that discovers it on the executor, never leaves the supervisor blind. When a sentinel's target is dead or retired with no successor, the notice is delivered to the live parent and the sentinel is re-targeted there instead of being parked and orphaned; `sweepWiringLifecycle` follows the same rule (re-point to the live parent, cancel only when none exists).

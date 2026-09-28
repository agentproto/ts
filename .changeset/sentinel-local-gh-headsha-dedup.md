---
"@agentproto/runtime": minor
---

`local-gh` sentinel provider: check-completed and closed events now key off the PR's head sha, so a new push whose CI concludes the same way as the last one (e.g. lint fails again) is no longer dropped by the delivery dedup, and a check that finishes between two polls on a new head is no longer masked by the old head's already-seen conclusions. `PrStatusSnapshot` gains an optional `headSha` field, and a new `github.pull_request.synchronize` event (now in the PR default type set) is emitted for the push itself.

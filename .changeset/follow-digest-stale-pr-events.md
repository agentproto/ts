---
"@agentproto/runtime": patch
"@agentproto/cli": patch
---

Session-follow digests no longer present restart catch-up as news.

After a daemon restart the PR settlement sweep re-asks the forge for every un-settled PR of every live registry session, so PRs merged weeks ago were emitted as `pr-merged` stamped with the sweep time and delivered to followers as fresh events from long-dead sessions.

- `makePrStateResolver` reads `state,mergedAt`; a merged PR's activity carries `endedAt` (the real merge time) and the `pr-merged` follow event uses it as its timestamp (`PrResolution` is exported; a resolver may still return a bare state).
- A `pr-merged` / `pr-opened` event older than 24 h (`FOLLOW_STALE_EVENT_MS`) is ignored and logged, never delivered as new.
- Every digest line now carries the event time: `[il y a 18 j, 29/10 05:27Z]`, and `[fusionnée il y a 18 j, 29/10 05:28Z]` for a pr-merged.

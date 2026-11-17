---
"@agentproto/sentinel": minor
"@agentproto/delivery-github": minor
---

Sentinels mark CI events for a superseded head commit instead of forwarding them as-is.

`@agentproto/sentinel`: the runtime remembers each PR's head sha (per sentinel, persisted as `headShas`) from `github.pull_request.*` events. A `check_suite`, `workflow_run` or `check_run` event whose `head_sha` is not the known head is delivered with `data.stale: true`, `data.current_head_sha`, a `[superseded]` summary prefix and `levelHint: 1`, at `fyi` urgency even with `delivery.apply` off, and never counts as terminal. It is never dropped. When the head is unknown (sentinel created after the last push, no `pull_request` event seen yet), nothing is marked. The rule runs in the shared per-event pipeline, so `webhook`, `agentpush` and polled providers all get it. New module `sentinel-head-tracker.ts` (`trackHead`, `markSuperseded`).

`@agentproto/delivery-github`: new `superseded` classifier, ahead of the failure rule, ranks a CI event with `data.stale === true` at level 1 (`fyi`); `isSupersededEvent` is exported.

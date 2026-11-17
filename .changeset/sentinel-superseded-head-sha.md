---
"@agentproto/sentinel": minor
"@agentproto/delivery-github": minor
---

Sentinels mark CI events for a superseded head commit instead of forwarding them as-is.

`@agentproto/sentinel`: per PR subject, the runtime keeps the current head sha and a bounded set of KNOWN superseded shas (per sentinel, persisted as `prHeads`), learned from `github.pull_request.*` events: a `synchronize`'s `before` sha (the normalizer now keeps `before` in `data`) and any previously recorded head. A `check_suite` or `workflow_run` event whose `head_sha` is a known superseded sha is delivered with `data.stale: true`, `data.current_head_sha`, a `[superseded]` summary prefix and `levelHint: 1`, at `fyi` urgency even with `delivery.apply` off, and never counts as terminal. It is never dropped. A CI event for a sha never seen (for example the new head whose `synchronize` has not arrived yet) is not marked, so out-of-order webhook deliveries cannot demote a real failure. Heads are learned before the per-clause `types` filter, and a PR's terminal event clears its entry. The rule runs in the shared per-event pipeline, so `webhook`, `agentpush` and polled providers all get it. New module `sentinel-head-tracker.ts` (`trackHead`, `markSuperseded`, `isStaleCiEvent`).

`@agentproto/delivery-github`: new `superseded` classifier, ahead of the failure rule, ranks a `check_suite` / `workflow_run` event with `data.stale === true` at level 1 (`fyi`); `isSupersededEvent` is exported.

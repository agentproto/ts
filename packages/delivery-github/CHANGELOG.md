# @agentproto/delivery-github

## 0.3.1

### Patch Changes

- 7144821: README: refresh the documented behaviour to match the shipped code (docs sync after the latest release).
- Updated dependencies [5b792bc]
  - @agentproto/delivery@0.3.1

## 0.3.0

### Minor Changes

- a786b17: Sentinels mark CI events for a superseded head commit instead of forwarding them as-is.

  `@agentproto/sentinel`: per PR subject, the runtime keeps the current head sha and a bounded set of KNOWN superseded shas (per sentinel, persisted as `prHeads`), learned from `github.pull_request.*` events: a `synchronize`'s `before` sha (the normalizer now keeps `before` in `data`) and any previously recorded head. A `check_suite` or `workflow_run` event whose `head_sha` is a known superseded sha is delivered with `data.stale: true`, `data.current_head_sha`, a `[superseded]` summary prefix and `levelHint: 1`, at `fyi` urgency even with `delivery.apply` off, and never counts as terminal. It is never dropped. A CI event for a sha never seen (for example the new head whose `synchronize` has not arrived yet) is not marked, so out-of-order webhook deliveries cannot demote a real failure. Heads are learned before the per-clause `types` filter, and a PR's terminal event clears its entry. The rule runs in the shared per-event pipeline, so `webhook`, `agentpush` and polled providers all get it. New module `sentinel-head-tracker.ts` (`trackHead`, `markSuperseded`, `isStaleCiEvent`).

  `@agentproto/delivery-github`: new `superseded` classifier, ahead of the failure rule, ranks a `check_suite` / `workflow_run` event with `data.stale === true` at level 1 (`fyi`); `isSupersededEvent` is exported.

## 0.2.1

### Patch Changes

- Updated dependencies [bf69bc9]
- Updated dependencies [3f92da0]
  - @agentproto/delivery@0.3.0

## 0.2.0

### Minor Changes

- 898175f: Move GitHub delivery knowledge out of the kernel: sentinel triage now runs
  through the delivery classifier registry, GitHub verdicts, the explicit triage
  table from #2444, coalesce keys and repeat keys live in
  `@agentproto/delivery-github`, and the runtime daemon registers that module
  next to `createSentinelRuntime`. The kernel drops `ClassifyContext.facts` and
  `Classifier.repeatKey`; `SentinelEvent` now extends the delivery `Envelope`.
  GitHub failures carry no repeat key, so a repeated failure on the same head
  still wakes.

  Decision changes from main, for a first non-terminal event:

  | Event type                             | Verdict                         | main | this branch |
  | -------------------------------------- | ------------------------------- | ---- | ----------- |
  | `github.check_suite.completed`         | `success`, `neutral`, `skipped` | wake | fyi         |
  | `github.workflow_run.completed`        | `success`, `neutral`, `skipped` | wake | fyi         |
  | `github.pull_request_review.submitted` | `approved`, `commented`         | wake | fyi         |
  | `github.issue_comment.created`         | bot actor                       | wake | fyi         |
  | `github.pull_request.synchronize`      | none                            | wake | fyi         |

  No other decision changes. Failure-class verdicts remain wake. Normalized
  `github.pull_request.closed` events remain wake because they are terminal, so
  the terminal rule wins before the closed rows in the table.

### Patch Changes

- Updated dependencies [c62b5de]
- Updated dependencies [898175f]
  - @agentproto/delivery@0.2.0

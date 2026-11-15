# @agentproto/delivery-github

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

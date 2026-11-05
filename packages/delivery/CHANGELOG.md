# @agentproto/delivery

## 0.2.0

### Minor Changes

- c62b5de: Add per-target batching to the delivery kernel. A sentinel target can set
  `batchMs`; a burst of envelopes for the same session inside that window is
  delivered as one message, so the session starts one turn instead of one per
  envelope. The ledger still records one line per envelope and target, and the
  sentinel triage level / rule for each event is unchanged. The sentinel default
  is `batchMs: 0`, which keeps the existing one-delivery-per-envelope behaviour.
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

## 0.1.0

### Minor Changes

- 7f9ea8b: New `@agentproto/delivery` package: the pure core of the delivery kernel (`Envelope`, `Level`, `levelToTier`, `computeLevel`, `createClassifierRegistry`, `RecentKeys`), with no I/O and no producer knowledge. `@agentproto/sentinel` now takes `RecentKeys` from it and re-exports it unchanged.
- cbbbee8: Add the append-only delivery ledger schema and writer, and make the sentinel record into it.

  - `@agentproto/delivery`: pure `LedgerLine` / `LedgerProducer` / `LedgerOutcome` types in the root entry, plus an opt-in `@agentproto/delivery/ledger-writer` subpath that appends one JSON line per delivery decision. The writer never throws and creates its parent directory with mode `0600`; the root entry stays I/O free.
  - `@agentproto/sentinel`: each delivered sentinel event appends one ledger line after the outcome is known (`delivered`, `queued`, `inbox`, `retargeted`, `parked`, `dropped`, or `duplicate`), carrying the triage `level`, `rule`, `repeatKey` and the message id. `sentinel-triage.jsonl` is no longer written; existing files are left in place. Delivery behaviour is unchanged.

# @agentproto/sentinel

## 0.6.0

### Minor Changes

- bf69bc9: Add the `delivery.apply.types` switch so a classified level can drive delivery (wake/fyi/drop; an applied level 3 is delivered as a wake and never downgraded or dropped) per event type, shadow by default, for both session follows and sentinels.
- 65633db: Sentinel signal routing, shadow only: a `sentinel.routes` rule table (match subject/types/from, `via` providers, `fallback`, `do: deliver | forward | drop`, `target`, `mode`) resolved most-specific-first, then list order, with visible `builtin:` defaults; an explicit `provider` still wins. `sentinel_watch` and `POST /sentinels` stamp the decision as `route` on the sentinel and log one line to `~/.agentproto/sentinel-routing.jsonl`, but the provider actually used is unchanged. New read-only `sentinel_routes` MCP tool, `GET /sentinels/routes[/explain]` and `agentproto sentinel routes [list|explain <subject>]`. `sentinel.autoWatchPrs`, `sentinel.autoWatchUrgency`, `sentinel.routes` and `sentinel.routing.mode` are now registered config keys.
- 3f92da0: Record a shadow `grant` verdict (`allow`, `deny`, `unknown` or `error`) on every delivery ledger line. The check observes publish and wake capabilities but never changes delivery; a throwing or slow decision leaves delivery untouched and is recorded as `error`.

### Patch Changes

- 900e930: Stop the PR auto-linker creating two identical sentinels for one PR: concurrent links for the same (PR, target session) are now guarded in flight, and `recordOpenedPr` dedupes on the PR url alone instead of (adapter, url).
- Updated dependencies [bf69bc9]
- Updated dependencies [3f92da0]
  - @agentproto/delivery@0.3.0

## 0.5.0

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

### Patch Changes

- 88087a1: Add an opt-in `claude-socket` wake adapter for external Claude Code sessions. When `daemon.claudeSocketWake` is true, a level 2 or higher message (next-turn, steer) to a `cc:<session_id>` row is delivered directly to the idle Claude Code process over its per-session unix socket, using the two-frame auth/user wire protocol; the message is consumed rather than also parked in the inbox, so a later Stop/UserPromptSubmit hook cannot re-inject it. Level 1 (fyi), `bypassPermissions` targets, and missing, non-socket, or foreign-owned registration/socket/key all fall back to the existing inbox delivery and report the reason on the send result. The `Notification` hook now refreshes the external row's liveness (POST /sessions/:id/touch), and `hook install` registers it alongside the existing inbox hooks.
- d30132f: Route a retired follower's digest to its live parent with its level kept and `routedTo` in the ledger, replay parked follow digests when the follower respawns (the retirement sweep replays before cancelling), and forward a sentinel notice for a closed session at its own level.
- Updated dependencies [c62b5de]
- Updated dependencies [898175f]
  - @agentproto/delivery@0.2.0

## 0.4.0

### Minor Changes

- cbbbee8: Add the append-only delivery ledger schema and writer, and make the sentinel record into it.

  - `@agentproto/delivery`: pure `LedgerLine` / `LedgerProducer` / `LedgerOutcome` types in the root entry, plus an opt-in `@agentproto/delivery/ledger-writer` subpath that appends one JSON line per delivery decision. The writer never throws and creates its parent directory with mode `0600`; the root entry stays I/O free.
  - `@agentproto/sentinel`: each delivered sentinel event appends one ledger line after the outcome is known (`delivered`, `queued`, `inbox`, `retargeted`, `parked`, `dropped`, or `duplicate`), carrying the triage `level`, `rule`, `repeatKey` and the message id. `sentinel-triage.jsonl` is no longer written; existing files are left in place. Delivery behaviour is unchanged.

### Patch Changes

- 7f9ea8b: New `@agentproto/delivery` package: the pure core of the delivery kernel (`Envelope`, `Level`, `levelToTier`, `computeLevel`, `createClassifierRegistry`, `RecentKeys`), with no I/O and no producer knowledge. `@agentproto/sentinel` now takes `RecentKeys` from it and re-exports it unchanged.
- Updated dependencies [7f9ea8b]
- Updated dependencies [cbbbee8]
  - @agentproto/delivery@0.1.0

## 0.3.0

### Minor Changes

- e45c909: The session message envelope now carries `from.relation: "granted"` (no tree edge, an allowance or grant admitted the send) instead of `"peer"`, plus `from.agentSlug` (the sender's AIP-42 agent); `from.role` stays one more release, deprecated.
  `"peer"` stays in the relation unions as a deprecated member (never produced): stored records are read as `granted`, exported records keep the historical value. The transcript exporter does not carry `from.agentSlug` (like `from.role`/`adapter`); it stays on the live/stored envelope. `@agentproto/sentinel` mirrors both changes, so it is a minor bump.
- 4a1139a: Give PR-watch sentinels one owner rule: the auto-linked `auto:pr#N` sentinel now targets the session that recorded the PR and that session's live parent, and a sentinel whose target is dead or retired with no successor is re-targeted to the live parent (rather than parked) so the supervisor is never left blind. `sweepWiringLifecycle` follows the same rule. Adds the optional `resolveParentSession` auto-link option and wires it from the gateway.
- 8c87741: Sentinel now redelivers events parked in `sentinels-parked.jsonl` once their sentinel gets a reachable target again: `SentinelRuntime.replayParked(sessionId?)` redelivers and drops the delivered journal lines, each poll tick replays for sentinels whose target changed since the last attempt (covering retargets and daemon boot), and the daemon replays for a session on `session:spawned`. Events parked because their subject was already closed are marked `replay: false` and never replayed.

  The daemon wires the new hook so a session that registers receives notices parked while it was unreachable.

- 4a1139a: One owner rule for PR watches: the auto-linked `auto:pr#N` sentinel now reaches the session the PR was recorded on AND that session's live parent (the supervisor), so a supervisor that opens a PR for an executor, or a reconciler that discovers it on the executor, never leaves the supervisor blind. When a sentinel's target is dead or retired with no successor, the notice is delivered to the live parent and the sentinel is re-targeted there instead of being parked and orphaned; `sweepWiringLifecycle` follows the same rule (re-point to the live parent, cancel only when none exists).
- 8c87741: Events parked in `sentinels-parked.jsonl` (target dead, retired or unresumable) are now redelivered once when their sentinel gets a reachable target again: the sentinel runtime exposes `replayParked(sessionId?)`, each poll tick replays for sentinels whose target changed since the last attempt (covers retargets and daemon boot), and the daemon replays for a session on `session:spawned`. Delivered lines are dropped from the journal; events parked because their subject was already closed are marked `replay: false` and never replayed.
- 4464e19: Sentinel triage treats `changes_requested` reviews and `action_required` check conclusions as wake-class (failure) verdicts, compares verdicts case-insensitively, and the `local-gh` provider now emits review `data.state` in lowercase so it matches the webhook provider (`CHANGES_REQUESTED` becomes `changes_requested`). Triage stays observation-only.

### Patch Changes

- Updated dependencies [3f90a9d]
  - @agentproto/provider-kit@0.6.0

## 0.2.0

### Minor Changes

- 07daf79: Extract the AIP-60 sentinel primitive into the new `@agentproto/sentinel` package. The sentinel store, runtime, providers, MCP tools and webhook outbox now live there; `@agentproto/runtime` depends on the package and re-exports the same public names.
- 07daf79: Extract the AIP-60 sentinel primitive into the new `@agentproto/sentinel` package (store, runtime, providers, MCP tools, webhook outbox). `@agentproto/runtime` now depends on the package through a runtime-owned platform-port layer and re-exports the same public names, so its API is unchanged.

### Patch Changes

- Updated dependencies [76003b9]
  - @agentproto/provider-kit@0.5.0

# @agentproto/sentinel

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

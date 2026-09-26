# @agentproto/transcript-fixtures

## 0.3.0

### Minor Changes

- ea5e30d: Add typed SessionMessage envelope + session-message transcript record for inter-session reports

### Patch Changes

- 65777ee: Keep the reported context window sticky: a cost-bearing usage_update's size is authoritative and no longer downgraded by later inferred frames (claude-agent-acp guesses 200k for 1M models until its first result). The daemon seeds the window from the model catalog at spawn, carries the adapter's `_claude/model` and `sizeInferred` on usage_update events, records `reportedSize` when it corrects a size, and treats a trailing `[1m]` lane hint (`claude-opus-5-5[1m]`) as an explicit window choice — not part of model identity for pricing/alias lookups.

## 0.2.1

### Patch Changes

- 2f37e7b: Bump third-party dependency versions (weekly deps update)

## 0.2.0

### Minor Changes

- ec4fda5: Add canonical RAW daemon-transcript fixtures package for anti-drift conformity testing.
- 8900417: Add support for `usage_update` and `usage_snapshot` transcript record kinds as known no-ops. These high-frequency cost/context bookkeeping records were previously falling through to the unknown-kind error path. Fixes spurious error chunks and console logging on every turn against a live daemon.

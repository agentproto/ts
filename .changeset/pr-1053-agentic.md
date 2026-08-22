---
"@agentproto/cli": patch
"@agentproto/harness": patch
"@agentproto/runtime": patch
"@agentproto/worktree": patch
---

Fix two critical bugs in `monitorSessionWait`:

1. **Stale fast-path**: The synchronous already-in-target-state check for `turn-end` now requires `opts.since !== undefined` to fire. Without a cursor anchor, there is no way to distinguish "the turn this wait is waiting for already finished" from "some turn finished hours ago". Fresh `agentproto sessions wait` CLI processes (which have no persisted cursor) now correctly fall through to the real bus-subscribe long-poll instead of instantly succeeding against stale history.

2. **Dropped empty/reason fields**: `SessionTurnEndEvent.empty` (zero assistant output, zero tool calls) and `.reason` (e.g. `"error"`) are now propagated through all three branches of the wait monitor (ring-replay, sync fast-path, bus long-poll) so callers can distinguish productive turns from silent no-ops (bad auth/model config) or adapter-reported errors. CLI exit code 4 is added for these cases.

Includes a new `currentEventsCursor()` method to capture race-free cursors for prompt+wait patterns that cannot otherwise subscribe before a turn completes.

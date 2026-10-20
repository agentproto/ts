---
"@agentproto/runtime": minor
---

Sandbox sessions gain a periodic in-turn checkpoint on its own `on: ["interval"]` trigger (configurable via `sandbox.checkpoint.intervalMs`, default every 10 minutes), so a turn running longer than the box lifetime is checkpointed mid-flight and not lost with the box. `"turn-end"` keeps wiring the timer as before, so an explicit `["turn-end", "teardown"]` config needs no migration. The periodic tick now also guards the box's free disk: under 10% it forces a checkpoint (bypassing the unchanged-since-last skip, but never running concurrently with another checkpoint) and emits a one-time warning into the session's transcript. New exported surface: `DISK_GUARD_MIN_FREE_FRACTION`, `buildDiskFreeCommand`/`parseDiskFree`/`diskFreeFraction`, and the proxy's `onWarning` callback.

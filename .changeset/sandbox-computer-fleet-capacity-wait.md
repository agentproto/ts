---
"@agentproto/sandbox-computer": minor
"@agentproto/runtime": patch
---

A computer create answered `503 fleet-capacity` is now retried instead of failing the spawn at once: the provider waits while the fleet frees or wakes a shelved host, for up to `fleetCapacityWaitMs` (default 12 minutes, `0` restores the old behaviour). Each wait honours `Retry-After`, else `fleetCapacityRetryMs` (default 30 s), is logged on the boot log, stops on cancellation, and does not count against `bootDeadlineMs`. Every attempt of one boot carries the same `Idempotency-Key`, so a replayed create never makes a second box. The `auto` provider turns the wait off for its computer leg when overflow to e2b is enabled, so a capacity refusal still overflows at once.

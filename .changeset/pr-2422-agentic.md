---
"@agentproto/sandbox-computer": minor
"@agentproto/runtime": patch
---

A computer `create` answered `503 fleet-capacity` is now retried for up to `fleetCapacityWaitMs` (default 12 minutes) instead of failing the spawn at once, honouring `Retry-After`/`fleetCapacityRetryMs`, stopping on cancellation, not counting the wait against `bootDeadlineMs`, and reusing one `Idempotency-Key` per boot. The `auto` provider disables this wait for its computer leg when e2b overflow is enabled so a capacity refusal still overflows immediately.

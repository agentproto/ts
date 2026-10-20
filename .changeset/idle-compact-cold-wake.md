---
"@agentproto/runtime": minor
---

Context continuity (AIP-46 amendment): add the opt-in `idleCompact` and `coldWakeGuard` policy blocks — both default `mode:"off"` — with whole-object (not field-by-field) precedence across config levels, `IDLE_COMPACT_DEFAULT_CACHE_TTL_MS` + per-adapter `metadata.promptCacheTtlMs` TTL resolution, pure arming/cold-detection helpers, and `lastTurnEndAt` / `cacheWarmUntil` observability on `ContextContinuityStatus`.

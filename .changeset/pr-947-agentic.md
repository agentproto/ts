---
"@agentproto/cli": minor
"@agentproto/runtime": minor
---

Enhance daemon lifecycle management with health reporting and shutdown statistics.

**@agentproto/cli changes:**
- New `runStop()` function exported for daemon stop command with pre-shutdown stats gathering
- `runStart()` and `runRestart()` now accept optional `health: HealthFetchFn` and `probeAttempts` parameters for testability
- New `DaemonHealthInfo` and `DaemonStopStats` interfaces enable rich metadata tracking
- Lifecycle info blocks report daemon version, uptime, workspace, binary path, and activity metrics (sessions, token counts, spend estimates)
- Enhanced `humaniseUptime()` to show nested units (e.g., `3h12m` instead of `3h`)
- Added `formatDuration()` helper for shutdown messages

**@agentproto/runtime changes:**
- `/health` endpoint now reports daemon version, process ID, node executable path, and entry point
- Added `startedAt` ISO timestamp to `/health` for debugging
- These metadata fields enable lifecycle tooling to accurately report "what is actually running"

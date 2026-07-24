---
"@agentproto/runtime": minor
---

Add machine-readable `timedOut` flag to `ExecuteResult` to distinguish timeout terminations from other SIGTERM events. Includes process-group-aware child termination and helpful stderr guidance when timeouts occur. Requires corresponding updates to `RecordCommandInput` and `CommandLogEntry` to fully propagate the field through command logging.

---
"@agentproto/driver-cli": patch
"@agentproto/workflow-runtime": minor
---

Fix a `kind: cli` tool step (and `kind: gate` step) hanging forever when the
subprocess leaves an orphaned grandchild holding its stdout/stderr pipe open
(e.g. a headless-Chrome renderer helper reparented to pid 1) — completion now
settles on the direct child's own `exit` instead of waiting on the stdio
`close` event, with a short drain window only as a ceiling. Both subprocess
runners spawn detached and kill the whole process group on abort/timeout, so
an orphan doesn't survive a cancel either. `tool` and `gate` steps also gain
their own `timeout_ms` (new exported `DEFAULT_STEP_TIMEOUT_MS`, new
`ToolStep.timeoutMs` field), defaulting to 10 minutes when unset.

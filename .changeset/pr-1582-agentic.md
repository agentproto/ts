---
"@agentproto/driver-cli": patch
"@agentproto/workflow-runtime": minor
---

Fix a `kind: cli` tool step (and `kind: gate` step) hanging forever when the subprocess leaves an orphaned grandchild holding its stdout/stderr pipe open (F45): completion now settles on the direct child's own `exit` instead of waiting on the stdio `close` event, with a short drain window only as a ceiling. Both subprocess runners spawn detached and kill the whole process group on abort/timeout.

For `@agentproto/workflow-runtime`, `tool` and `gate` steps gain a per-step `timeout_ms` (`timeoutMs` on the compiled step) defaulting to 10 minutes via the new exported `DEFAULT_STEP_TIMEOUT_MS`, and the AIP-15 draft schema documents `timeout_ms` for both step kinds — hence the minor bump over the committed patch-only changeset.

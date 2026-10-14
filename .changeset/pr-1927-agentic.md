---
"@agentproto/runtime": minor
"@agentproto/cli": patch
---

Add `turnRetry.action: "migrate"` (with `maxMigrations`): on a matching turn failure the daemon migrates the session to a fresh sandbox box via `migrateSandboxSession`, falling back to a normal retry on failure. Adds `migrated`/`migrate-failed` retry phases and the `turnMigrations` descriptor counter, carried over to the migrated session together with `turnRetryAttempts` and the `turnRetry` policy itself. `--turn-retry` (CLI) validates and documents the new `action` / `maxMigrations` keys.

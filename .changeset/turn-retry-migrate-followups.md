---
"@agentproto/runtime": patch
"@agentproto/cli": patch
---

`turnRetry.action: "migrate"` follow-ups: the migrated session now inherits the `turnRetry` policy itself (so its first migration no longer drops the rule) and the migration cap is enforced across sessions; `maxMigrations` accepts `0`; a give-up after migrations says so in the `[turn-retry] gave up after` notice; a failed migration with a spent retry budget gives up instead of booking an over-budget retry. `--turn-retry` (CLI) validates and documents `action` / `maxMigrations`.

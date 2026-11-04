---
"@agentproto/worktree": patch
---

Fix `branch gc approve` refusing with `tip-moved` for stored verdicts whose name is a display label (`remote:feat/x`, `local:a, local:b`): the name is now resolved into branch names and every matching ref at the sha is reported.

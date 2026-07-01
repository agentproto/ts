---
"@agentproto/cli": patch
---

Surface busy/idle activity and stale "running" (dead pid) state in `agentproto sessions` and the `--watch` dashboard, which previously showed STATUS without any indication of `busy`/`awaitingInput`/`processAlive` even though the daemon already reports them.

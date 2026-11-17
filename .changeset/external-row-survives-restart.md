---
"@agentproto/runtime": patch
---

A daemon restart no longer kills external (Claude Code / Desktop) rows. The graceful shutdown sweep now persists a live external row as `exited` with no `endedReason` (the open-inbox shape the crash/boot path already used), so sentinel and follow deliveries reach it, socket wake included, right after the restart instead of bouncing until the session acts on its own. Rows an older daemon already persisted as `killed`/`daemon-restart` are healed on boot; an operator kill or retire still ends the row.

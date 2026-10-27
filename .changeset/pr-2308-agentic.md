---
"@agentproto/cli": patch
---

Fix `sessions wait --until turn-end` treating a freshly spawned prompted session as idle before its first turn ran. The idle short-circuit now requires at least one completed turn (or a terminal session status) before deciding there is nothing to wait for.

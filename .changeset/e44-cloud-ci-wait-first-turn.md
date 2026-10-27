---
"@agentproto/cli": patch
---

Fix `sessions wait --until turn-end` treating a freshly spawned prompted session as idle before its first turn ran.

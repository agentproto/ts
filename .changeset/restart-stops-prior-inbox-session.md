---
"@agentproto/runtime": patch
---

`session_restart` stops the prior in-box session before re-spawning, so two adapters never run in the same sandbox box.

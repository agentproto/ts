---
"@agentproto/runtime": patch
---

`settlePendingWrites()` now also waits for the transcript-stream closes that `forget()` and `shutdown()` start, so the sessions tests can drain every write before removing their temp dir instead of retrying the removal on ENOTEMPTY.

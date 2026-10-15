---
"@agentproto/pairing-host": patch
---

Rate-limit the pairing channel up/closed reconnect-flap logs, so a flapping
sandbox-join channel no longer floods the daemon log with two lines per cycle.

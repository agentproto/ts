---
"@agentproto/acp": patch
"@agentproto/pairing-host": patch
"@agentproto/runtime": patch
---

Close sockets after failed handshakes, drop stale abort listeners, and fail ready() promptly on a pre-hello tunnel error or close

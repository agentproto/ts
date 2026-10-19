---
"@agentproto/sandbox-computer": patch
"@agentproto/sandbox": patch
---

`computer` sandbox provider: session refcount. `config.maxSessions` is forwarded at create so the controller sizes the computer for it, boot and connect attach a session, pause and stop detach it, and the last session to stop removes the computer. A connect past the controller's cap is refused. A controller without the attach routes keeps the per-process count.

A daemon-connect failure on a freshly booted box now removes the box instead of pausing it; a reconnected box is still paused.

---
"@agentproto/computer-api": patch
"@agentproto/sandbox-computer": patch
"@agentproto/sandbox": patch
---

`computer` sandbox provider: session refcount. `config.maxSessions` is forwarded at create so the controller sizes the computer for it, boot and connect attach a session, pause and stop detach it, and the last session to stop removes the computer. A stop whose detach is not answered leaves the computer in place and reports it. A connect past the controller's cap is refused. A controller without the attach routes keeps the per-process count. `@agentproto/computer-api` gains `maxSessions` on the create request and `sessionsResponseSchema` for attach and detach.

A daemon-connect failure on a freshly booted box now removes the box instead of pausing it; a reconnected box is still paused.

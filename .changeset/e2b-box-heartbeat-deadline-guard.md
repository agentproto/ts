---
"@agentproto/runtime": patch
"@agentproto/sandbox-e2b": patch
---

Sandbox boxes no longer expire under a busy turn that streams nothing: while a turn is in flight the session proxy re-arms the box lifetime every 10 minutes, on top of the per-prompt and per-event renewals. About 5 minutes before the box's known deadline the proxy renews once more if a turn is still in flight, and otherwise (idle, or the renewal failed) runs a final checkpoint while the box is still reachable, instead of probing it after it is gone. Heartbeat and guard stop on close and on detach.

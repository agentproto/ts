---
"@agentproto/runtime": patch
---

Stop the workflow runner from starving the event loop. Every step transition rewrote the entire runs file synchronously (228 MB with a few hundred retained runs), which blocked the loop for minutes across a long run so the lease heartbeat never fired and the liveness sweep orphaned healthy runs. Writes that don't change any run's status are now coalesced to at most one per `persistMinIntervalMs` (default 2s, trailing flush, flush on exit); status changes still flush immediately and the file is written compact. The daemon's liveness sweep also skips a tick that fired seconds late, since overdue renewals mean a starved loop rather than dead owners.

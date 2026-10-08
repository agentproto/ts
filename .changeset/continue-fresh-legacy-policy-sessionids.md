---
"@agentproto/runtime": patch
---

`session_continue_fresh` no longer fails with `Cannot read properties of undefined (reading 'includes')` when the daemon's `policies.json` holds terminal policies persisted before fan-in `sessionIds` existed. Reload now normalizes `sessionIds`/`pending` on terminal policies, as it already did for active and awaiting-ack ones, and `policyWatchesSession` tolerates a state without `sessionIds`.

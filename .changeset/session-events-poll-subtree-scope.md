---
"@agentproto/runtime": patch
---

`session_events_poll` now applies WP6 subtree scoping: a scoped child orchestrator polling events only sees lifecycle events for sessions within its own subtree (previously it could observe turn-end/awaiting-input/exited/permission events for sessions outside it). Root/operator callers (no scope) see unchanged output.

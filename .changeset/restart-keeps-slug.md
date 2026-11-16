---
"@agentproto/runtime": patch
---

A restarted or continued session keeps its predecessor's slug instead of
drifting to `x-2`, `x-3`, ... (one long-lived session had reached `-32`).
Restart (host and box), the PTY restart and `session_continue_fresh` now pass an
internal `replaces` to the spawn: the new row takes over the replaced row's slug
verbatim (a `session_rename` included) and the replaced row gives it up. The
transfer happens whatever the replaced row's status, since a restart mints while
its predecessor is still running. `agent_start.succeeds` is unchanged (the
predecessor stays live and keeps its slug) and `resolveSessionRef` is untouched.
A superseded session is now addressed by its id, no longer by its old slug.

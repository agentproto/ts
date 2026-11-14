---
"@agentproto/runtime": patch
---

A session that the idle reaper freed and a later prompt resumed in place (same id) can mint Bureau sub-session tokens again. The minter used to keep every exited session id revoked for the daemon's whole life, so a resumed session failed every Bureau call with `the session ended` until restart. `session:resumed` now reinstates a live, non-retired session; a retired or unknown id is never reinstated. A mint waits for any server-side DELETE still owed for the id, so a late DELETE cannot revoke the new token.

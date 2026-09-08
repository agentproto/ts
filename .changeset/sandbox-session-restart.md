---
"@agentproto/runtime": patch
---

Fix `session_restart` on a sandboxed agent session: re-attach the existing box via its provider `connect()` and re-spawn the adapter inside it, failing loud when the box is expired instead of spawning locally against a box cwd.

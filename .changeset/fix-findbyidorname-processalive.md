---
"@agentproto/runtime": patch
---

Fix `processAlive` returning `undefined` from `GET /sessions/:id` (and any
other call through `findByIdOrName`) even when the session's pid is alive.
`findByIdOrName` read the internal sessions map directly and skipped the
`stampProcessAlive` call that `get()`/`list()` already perform, on both the
direct-id match and the name-match fallback loop.

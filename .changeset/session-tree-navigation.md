---
"@agentproto/runtime": minor
---

`session_tree`: add navigable `nodeId` + `direction` params (`children` / `parent` / `siblings` / `ancestors` / `descendants`) with an optional `depth` level cap, returning a single slice of the session tree instead of the full dump. Omitting both keeps today's full-tree/`byOrigin` behavior unchanged; passing only one of the two is a validation error, and an unknown `nodeId` returns a clear error.

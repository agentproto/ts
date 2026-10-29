---
"@agentproto/runtime": patch
---

`session_migrate` now hands an orchestrator's scope and children over to the migrated session, matching `session_restart`: the new session keeps the same scope-token and parameters, owned by its own id, so closing the old row no longer revokes the token the new row carries and the new row's real exit later revokes the scope and reaps its children. A box that crashed before the migration gets its scope reinstated for the new session, and a failed migration leaves the scope with the old session.

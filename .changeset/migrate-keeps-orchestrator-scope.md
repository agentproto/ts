---
"@agentproto/runtime": patch
---

`session_migrate` now hands an orchestrator's scope over to the migrated session, like `session_restart` does: the new session keeps the same scope-token and parameters, owned by its own id, so closing the old row no longer revokes the token the new row carries, and the new row's real exit still revokes the scope and reaps its children. A box that crashed before the migration gets its scope reinstated for the new session, and a migration that fails leaves the scope with the old session.

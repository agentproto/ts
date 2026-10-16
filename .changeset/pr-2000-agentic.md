---
"@agentproto/runtime": minor
---

Service-owner launcher for an app manifest's `services:` block (Pygmalion phase
1b item 2): `parseAppServices` validates the frozen `{ name, entry, port? }`
shape, `ensureAppServiceOwners` spawns one `keepAlive` + `restartPolicy` owner
session per entry via `spawnAgentSession` and persists per-service ownership
(install/apply/catalog), and `app_uninstall` kills every owner session and
recorded pid via `removeAppServiceOwners`.

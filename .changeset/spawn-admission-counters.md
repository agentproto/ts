---
"@agentproto/runtime": minor
---

The daemon now counts its spawn admission decisions (reuse, deny, allow per stage) and `GET /spawn-admission` reads them, with one `[spawn-admission]` log line per non-allow decision. `canSpawn` takes an optional `ignoreLevel`, and no decision changes.

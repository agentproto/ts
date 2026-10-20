---
"@agentproto/app-config": patch
"@agentproto/apps": patch
---

`@agentproto/app-config`: restore the executable bit on `bin/app-config.mjs` so the declared package.json `bin` entry is actually runnable, matching its sibling `packages/secrets/bin/agentproto-secrets.mjs`.

`@agentproto/apps`: add `session-steward/scripts/sessions-digest.sh`, a companion to `sessions-snapshot.sh` that summarizes the last N hours of daemon sessions into attention/in-progress/closed/dead buckets.

---
"@agentproto/runtime": minor
---

Add a one-owner lock per PR or branch to `agent_start`: `ownerKey` (`pr:<owner>/<repo>#<n>` or `branch:<name>`, canonicalised) refuses a second spawn with `owner_busy` while a live session — or one that ended less than 24h ago — already holds the key, returning that owner's session id. `takeOver: true` overrides explicitly.

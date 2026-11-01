---
"@agentproto/adapter-opencode": patch
---

Resolve a pinned opencode console org across every login stored in `opencode.db`, not only the active one. The active login is tried first, expired logins are skipped, a login whose `/api/orgs` call fails does not hide the org held by another, and the final error names the logins tried without their tokens. With a single usable login the behaviour is unchanged.

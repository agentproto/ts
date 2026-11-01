---
"@agentproto/adapter-opencode": patch
---

Resolve a pinned opencode console org across every login stored in `opencode.db`, not only the active one. The active login is tried first, expired logins are skipped, and a failed `/api/orgs` call on one login no longer hides an org held by another; the final error names the logins tried without exposing their tokens.

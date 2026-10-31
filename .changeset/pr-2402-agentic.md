---
"@agentproto/runtime": minor
---

`role_list` rows now carry `delegatesTo`, the agents a role declares it may spawn. The delegation gate resolves the calling agent from the owner session's recorded `agentSlug` first, so a session bound to a manifest agent is judged the same way on the scoped and unscoped paths; the scope's role (scoped) or the owner's recorded `role` (unscoped) names it only when no `agentSlug` is recorded.

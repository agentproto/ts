---
"@agentproto/runtime": minor
---

`role_list` rows now carry `delegatesTo`, the agents a role declares it may spawn. The delegation gate names the calling agent from the owner session's recorded `agentSlug` first, so a session bound to a manifest agent is judged the same way on the scoped and unscoped paths (it was judged as its role on the scoped one).

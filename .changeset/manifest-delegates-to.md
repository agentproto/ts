---
"@agentproto/runtime": minor
---

The runtime now reads an AIP-42 manifest agent's `delegates_to` once at spawn (agent ids and role names), records the resolved identities on the session, and the delegation gate evaluates them for manifest-bound callers, with the default `observe` mode changing no decision. An absent or empty list, or an entry it cannot resolve yet, stays `undeclared`, and the list is frozen at spawn.

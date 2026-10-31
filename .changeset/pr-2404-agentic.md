---
"@agentproto/runtime": minor
---

The runtime now reads an AIP-42 manifest agent's `delegates_to` once at spawn, resolves each entry to an agent identity or role name, and records the frozen list on the session as `meta.agentDelegatesTo`. The delegation gate evaluates that recorded list for manifest-bound callers; `observe` remains decision-neutral, while `enforce` gains the manifest allowlist. An absent, empty, or partly unresolvable list stays `undeclared` and on the legacy lattice, and a restart carries the frozen list.

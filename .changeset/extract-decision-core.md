---
"@agentproto/decision": minor
"@agentproto/runtime": patch
---

Extract the AIP-65 decision core into the new `@agentproto/decision` package. Policy parsing, bounded evidence collection, and the typed decision primitive now live there; `@agentproto/runtime` depends on the package and re-exports the same public names.

---
"@agentproto/clerk": minor
"@agentproto/runtime": patch
---

Extract the AIP-68 clerk pass into the new `@agentproto/clerk` package. The hook configuration, the turn-end subscriber and the pass runner now live there; `@agentproto/runtime` depends on the package and re-exports the same public names.

---
"@agentproto/provider-kit": minor
"@agentproto/runtime": patch
---

Move the sandbox and tunnel families onto `makeProviderFamily()`, with no behavior change: same tool names, descriptions, results and hints. provider-kit gains an explicit `legacySetup` option that reproduces their setup semantics (a field without `required` is optional, re-setup replaces the stored creds, store and ledger errors propagate), `load` now also receives slugs outside the catalog (a composite slug such as `auto`), and `registerTools` accepts a missing `list`.

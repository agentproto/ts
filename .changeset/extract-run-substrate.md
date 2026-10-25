---
"@agentproto/run": minor
"@agentproto/runtime": patch
---

Extract the AIP-58 run substrate into the new `@agentproto/run` package. The per-run workspace, the append-only event log, the on-disk run store, the file-backed step cache, and the pure run-record types now live there; `@agentproto/runtime` depends on the package and re-exports the same public names.

# @agentproto/run

## 0.2.0

### Minor Changes

- 89e3acc: Extract the AIP-58 run substrate into the new `@agentproto/run` package. The per-run workspace, the append-only event log, the on-disk run store, the file-backed step cache, and the pure run-record types now live there; `@agentproto/runtime` depends on the package and re-exports the same public names.
- 89e3acc: Extract the AIP-58 run substrate into the new `@agentproto/run` package: the per-run workspace layout, the append-only event log, the on-disk run store, the file-backed step cache, and the pure run-record types. `@agentproto/runtime` depends on the package and re-exports the same public names, so existing consumers keep working.

### Patch Changes

- @agentproto/workflow-runtime@0.20.2

# @agentproto/clerk

## 0.2.1

### Patch Changes

- bc18933: A clerk command's stderr is appended to `~/.agentproto/logs/clerk-<sessionId>.err` instead of being dropped, so a failing pass (exit 1) leaves a cause behind.

## 0.2.0

### Minor Changes

- 3e78d31: Extract the AIP-68 clerk pass into the new `@agentproto/clerk` package. The hook configuration, the turn-end subscriber and the pass runner now live there; `@agentproto/runtime` depends on the package and re-exports the same public names.
- 3e78d31: Extract the AIP-68 clerk pass into the new `@agentproto/clerk` package: hook configuration (agent > workspace > daemon resolution), the debounced/single-flight turn-end subscriber, and the routine/command pass runner now live there. `@agentproto/runtime` depends on the package and re-exports the same public names, so its public API is unchanged.

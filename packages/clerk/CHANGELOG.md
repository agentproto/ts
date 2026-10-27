# @agentproto/clerk

## 0.2.0

### Minor Changes

- 3e78d31: Extract the AIP-68 clerk pass into the new `@agentproto/clerk` package. The hook configuration, the turn-end subscriber and the pass runner now live there; `@agentproto/runtime` depends on the package and re-exports the same public names.
- 3e78d31: Extract the AIP-68 clerk pass into the new `@agentproto/clerk` package: hook configuration (agent > workspace > daemon resolution), the debounced/single-flight turn-end subscriber, and the routine/command pass runner now live there. `@agentproto/runtime` depends on the package and re-exports the same public names, so its public API is unchanged.

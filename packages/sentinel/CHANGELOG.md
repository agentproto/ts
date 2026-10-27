# @agentproto/sentinel

## 0.2.0

### Minor Changes

- 07daf79: Extract the AIP-60 sentinel primitive into the new `@agentproto/sentinel` package. The sentinel store, runtime, providers, MCP tools and webhook outbox now live there; `@agentproto/runtime` depends on the package and re-exports the same public names.
- 07daf79: Extract the AIP-60 sentinel primitive into the new `@agentproto/sentinel` package (store, runtime, providers, MCP tools, webhook outbox). `@agentproto/runtime` now depends on the package through a runtime-owned platform-port layer and re-exports the same public names, so its API is unchanged.

### Patch Changes

- Updated dependencies [76003b9]
  - @agentproto/provider-kit@0.5.0

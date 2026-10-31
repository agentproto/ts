# @agentproto/sentinel

## 0.3.0

### Minor Changes

- e45c909: The session message envelope now carries `from.relation: "granted"` (no tree edge, an allowance or grant admitted the send) instead of `"peer"`, plus `from.agentSlug` (the sender's AIP-42 agent); `from.role` stays one more release, deprecated.
  `"peer"` stays in the relation unions as a deprecated member (never produced): stored records are read as `granted`, exported records keep the historical value. The transcript exporter does not carry `from.agentSlug` (like `from.role`/`adapter`); it stays on the live/stored envelope. `@agentproto/sentinel` mirrors both changes, so it is a minor bump.

### Patch Changes

- Updated dependencies [3f90a9d]
  - @agentproto/provider-kit@0.6.0

## 0.2.0

### Minor Changes

- 07daf79: Extract the AIP-60 sentinel primitive into the new `@agentproto/sentinel` package. The sentinel store, runtime, providers, MCP tools and webhook outbox now live there; `@agentproto/runtime` depends on the package and re-exports the same public names.
- 07daf79: Extract the AIP-60 sentinel primitive into the new `@agentproto/sentinel` package (store, runtime, providers, MCP tools, webhook outbox). `@agentproto/runtime` now depends on the package through a runtime-owned platform-port layer and re-exports the same public names, so its API is unchanged.

### Patch Changes

- Updated dependencies [76003b9]
  - @agentproto/provider-kit@0.5.0

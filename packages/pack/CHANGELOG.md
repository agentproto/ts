# @agentproto/pack

## 0.2.4

### Patch Changes

- Updated dependencies [461df5e]
  - @agentproto/define-doctype@0.1.3

## 0.2.3

### Patch Changes

- 835738c: Corrects the incorrect AIP-52 attribution in `@agentproto/pack`: PACK.md has no assigned AIP (AIP-52 is ADAPTER, implemented by `@agentproto/mastra`). Updates package metadata, docs, and comments accordingly; runtime error strings are unchanged.

## 0.2.2

### Patch Changes

- c27f0b8: Weekly minor/patch dependency bumps across workspaces (zod, @mastra/*, react, yaml, claude-agent-sdk, etc.).

## 0.2.1

### Patch Changes

- 2f37e7b: Bump third-party dependency versions (weekly deps update)
- Updated dependencies [2f37e7b]
  - @agentproto/define-doctype@0.1.2

## 0.2.0

### Minor Changes

- 9f584c4: Rename "plugins" to "adapters" in the CLI to free up "plugin" for Agent Plugins v1.0.0 standard. This is a breaking change: `agentproto plugins` → `agentproto adapters`, config key `plugins[]` → `adapters[]`, manifest schema `agentproto/plugin/v1` → `agentproto/adapter/v1`.

  Introduce `@agentproto/pack` (AIP-52 PACK.md reference implementation) and `@agentproto/plugin` (Agent Plugins v1.0.0 reference implementation) packages.

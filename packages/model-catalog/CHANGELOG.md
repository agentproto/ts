# @agentproto/model-catalog

## 0.4.0

### Minor Changes

- b531fd1: Add llm:context-windows generator and resolveContextWindow to model-catalog

## 0.3.0

### Minor Changes

- 1bdc055: Add xAI provider support and session options passthrough (base-url/auth-token/options-json)
- afbf5c4: Register claude-opus-4-8, claude-sonnet-5, claude-fable-5 in pricing catalog; decouple runnable from pricing presence
- d425044: Add catalog-sourced billing-credential resolver for all adapters
- d924e95: Add route-identity subpath to model-catalog and refresh-workflow + OpenAI source to catalog-sync

### Patch Changes

- 7b53b8c: Relicense all packages from MIT to Apache-2.0

## 0.2.0

### Minor Changes

- 7a310ff: Add model-catalog package, provider-key store, and `agentproto models` command
- fd03e5c: Add live-on-setup voice overlay and fix OpenRouter cache field names

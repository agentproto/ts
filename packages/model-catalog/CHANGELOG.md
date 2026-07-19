# @agentproto/model-catalog

## 0.6.0

### Minor Changes

- 9e30ad2: Refresh Moonshot/OpenRouter snapshots, add Kimi K3 + K2.7 Code pricing

## 0.5.0

### Minor Changes

- 719771e: Inject provider-key env aliases (google → GOOGLE_API_KEY) at serve boot
- 9c2cec0: Add the Requesty LLM pricing catalog: a `catalog-sync` generator over
  `https://router.requesty.ai/v1/models` emitting `REQUESTY_ROUTES` (553 routes
  from a 563-model pinned snapshot), and a `requesty` branch in
  `resolveLlmModelRoute` so `<vendor>/<product>@requesty` prices independently of
  the direct vendor route — `sference/thinkingcap-qwen3.6-27b@requesty` → $0.4/$3
  in, bare `openai/gpt-4.1` still → the direct OpenAI price.

  `REQUESTY_ROUTES` is intentionally not spread into `LLM_PRICING_CATALOG`; that
  map is the legacy bare-id path and a second router in it would repoint
  direct-vendor ids at router pricing. `requesty` joins `CatalogProviderSchema`
  and `PROVIDER_KEY_ENV`.

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

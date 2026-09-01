# @agentproto/model-catalog

## 0.9.0

### Minor Changes

- 001a2a0: Refactor model catalog to derive existence from live-synced sources, not hand-typed pricing rows.

  **Model existence inversion**: `LlmModelId` union now derives from `CONTEXT_WINDOWS` + `OPENROUTER_ROUTES` keys, with pricing overlaid on top. Hand-written pricing is now bounded to the `PRICING_OVERRIDES` map (rare edge cases only).

  **Native model lists**: Both Anthropic adapters now use `listNativeModelIds("anthropic")` with an empty denylist, eliminating the hand-maintained list. Google native ids extracted to `google-native-model-ids.mjs` for reuse across sync scripts.

  **Sync scripts**: Added generators for Anthropic, xAI, Google, OpenAI, MiniMax. Fallback strategy: Anthropic uses `CONTEXT_WINDOWS` when API key unavailable.

  **Pricing optionality**: `ResolvedModel.pricing?: LLMPricing` signals "known but unpriced" models. Consumers updated (enrichment, registry, cost dispatcher).

  **Data quality**: Generated prices replace stale hand-typed entries. No pricing regressions; Anthropic, Mistral, Moonshot, Groq all carry live sync-derived values or documented placeholders.

### Patch Changes

- 4b924c9: Sync generated catalog data from the pinned provider sources.
- 008a483: Sync generated catalog data from the pinned provider sources.
- 3496977: Sync generated catalog data from the pinned provider sources.
- 008a483: Extended llm:context-windows generator to sync Mistral context windows from api.mistral.ai/v1/models; added pinned snapshot and regenerated context-windows export with 56 new Mistral models.
- f0c51a7: Weekly dependency bump: update 9 minor/patch dependencies to latest versions.
  - @anthropic-ai/claude-agent-sdk 0.3.241 → 0.3.251
  - @ast-grep/napi 0.45.2 → 0.45.3
  - @earendil-works/pi-tui 0.84.2 → 0.84.4
  - @tanstack/react-query 5.102.2 → 5.102.8
  - @testing-library/react 16.3.2 → 16.3.3
  - e2b 2.45.0 → 2.46.1
  - tsx 4.23.12 → 4.23.13
  - turbo 2.10.11 → 2.10.12
  - zod 4.4.3 → 4.5.4

  No code changes; pnpm-lock.yaml updated to reflect new dependency versions.

- 5dcc733: Fix missing bare Anthropic model IDs in context-windows generator. Some Anthropic model generations age out of the live /v1/models listing into dated-only IDs (e.g., `claude-opus-4-5-20251101`), but the bare "latest" spelling (e.g., `claude-opus-4-5`) remains a valid, callable back-compat ID. The pricing generator already derives these bare IDs from their dated siblings, but the context-windows generator was missing this logic, which dropped them from listNativeModelIds and every adapter's native model menu. Now derived identically to pricing.

## 0.8.5

### Patch Changes

- 95f7b5e: Sync generated catalog data from the pinned provider sources.
- e826a4a: Sync generated catalog data from the pinned provider sources.
- 1fd4a15: Make live OpenRouter pricing resilient to testing via snapshots instead of hardcoded assertions. Prices are re-synced weekly by catalog-sync, so snapshot diffs show legitimate changes as reviewable without breaking CI. Also fixes changeset naming collision in sync script that broke #1040/#1063.

## 0.8.4

### Patch Changes

- 7b28edf: Refresh the Mistral model catalog from the live /v1/models list (adds the
  medium tier, codestral, devstral, ministral, magistral; drops retired ids)
  and declare a model list on the mistral-vibe generic-ACP spec so its launch
  picker offers real models instead of only "custom".
- e8d39e8: Add catalog sync scripts for Mistral and Moonshot: ids from each provider's
  live /v1/models (with OpenRouter fallback for Moonshot), pricing from
  OpenRouter's public API, emitted as generated files spread beneath the
  hand-maintained entries so curated pricing always overrides.

## 0.8.3

### Patch Changes

- 415044d: Sync generated catalog data from the pinned provider sources.

## 0.8.2

### Patch Changes

- 2b58616: Sync generated catalog data from the pinned provider sources.
- 6e1fcf3: Remove tilde-prefixed OpenRouter aliases and use non-throwing route resolution in widening

## 0.8.1

### Patch Changes

- 4b6bbe6: Documentation sync: update version to 0.11.1-alpha and document new spawn policies (dedupe/attach), judge gate structured verdicts, implicit session deduplication, and worktree async provisioning.

## 0.8.0

### Minor Changes

- 980276e: Router-aware LLM model enumeration for Requesty and HuggingFace.

  Introduces `listRouterLlmRoutes` to systematically enumerate all models a router serves, and enhances `getModelsByProvider` to fold these router tables into provider queries while deduplicating against OpenRouter's existing bare-id surface. Requesty and HuggingFace models now enumerate from their generated route tables as `vendor/product@router` ids. Claude SDK adapter adds Requesty model curation to its allowed list.

### Patch Changes

- c825a12: Sync generated catalog data from the pinned provider sources.

  catalog-sync and runtime are named because their `src/__tests__` assertions
  had to follow the refreshed data (context-window entry count, gpt-5.6 tier
  repricing), and the coverage check counts anything under `src/` as
  publish-affecting.

## 0.7.0

### Minor Changes

- 358af0e: Fix first-party models incorrectly marked ineligible on vendor routes due to router pricing-key collisions. Introduce `resolvePricingExact` to avoid substring-matching false positives (e.g., `google/gemini-2.5-flash-image` → `gemini-2.5-flash`). Restore vendor route for `anthropic/claude-sonnet-5` and `anthropic/claude-fable-5` on direct Anthropic auth.
- ec5f64f: Fix model ID routing for Anthropic-native adapters: reduce direct-anthropic refs (e.g., `anthropic/claude-sonnet-4-5`) to bare product IDs that the native Anthropic wire expects, while preserving vendor/product for gateway-routed models and non-Anthropic adapters.
- 1ea7682: Refresh provider-sourced model catalogs (OpenRouter, Requesty, HuggingFace, Moonshot, xAI) from live provider data: adds newly available models (e.g. claude-opus-5 and variants, gemini-3.5/3.6 entries) and updates pricing for existing entries. Data-only refresh via the existing catalog-sync generators; no adapter or routing logic changed.
- 42f1217: Fix routing and credential injection for gateway-routed adapters (D1-D5)
  - D1: Base URL injection gate — skip gateway baseUrl for derived-from-model adapters (hermes); fail loud when adapter can neither accept baseUrl nor derive its route
  - D2: Wire model form — generalized stripFixedNativeVendor for fixed-provider adapters (codex/openai, codex/gpt-5 not openai/gpt-5)
  - D3: Model-derived provider precedence — adapter-declared modelProviders wins over global catalog routing (pi bills kimi via moonshot, not openrouter)
  - D4: Gateway credential injection — resolveAuthSpec honors adapter-declared gatewayAuth.setEnv instead of preset keyEnv (claude-sdk reads ANTHROPIC_AUTH_TOKEN, not OPENROUTER_API_KEY)
  - D5: LLM endpoint adoption — status report never contradicts (running:false, healthy:true); adopt external healthy endpoints as owner:external with probed model list

  New exports: LlmEndpointStatusReport, stripFixedNativeVendor, routeSelection in AgentAdapterResolver.

### Patch Changes

- f1484a4: Add `stripRouteSuffix()` utility to strip catalog @route suffix before passing model IDs to upstream providers, and fix llm-endpoint keyEnv from LLM_ENDPOINT_API_KEY to LLM_ENDPOINT_ACCESS_TOKENS.
- 0f10338: Add built-in custom route for local llm-endpoint Anthropic-compatible proxy. The runtime now registers the llm-endpoint route at daemon boot, allowing curated model references (e.g., moonshot/kimi-k2.7-code@llm-endpoint) to transparently route through the local proxy. Configuration is derived from the gateway preset to ensure single source of truth.

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

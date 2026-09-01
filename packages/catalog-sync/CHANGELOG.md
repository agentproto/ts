# @agentproto/catalog-sync

## 0.5.9

### Patch Changes

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

- 4b924c9: Fixes to context-windows generator: test assertion changed to floor (preventing automation failures on normal sync drift), and derived bare Anthropic model IDs from dated siblings (same fix pattern as pricing generator, addresses regression from pricing refactoring).
- 001a2a0: Refactor model catalog to derive existence from live-synced sources, not hand-typed pricing rows.

  **Model existence inversion**: `LlmModelId` union now derives from `CONTEXT_WINDOWS` + `OPENROUTER_ROUTES` keys, with pricing overlaid on top. Hand-written pricing is now bounded to the `PRICING_OVERRIDES` map (rare edge cases only).

  **Native model lists**: Both Anthropic adapters now use `listNativeModelIds("anthropic")` with an empty denylist, eliminating the hand-maintained list. Google native ids extracted to `google-native-model-ids.mjs` for reuse across sync scripts.

  **Sync scripts**: Added generators for Anthropic, xAI, Google, OpenAI, MiniMax. Fallback strategy: Anthropic uses `CONTEXT_WINDOWS` when API key unavailable.

  **Pricing optionality**: `ResolvedModel.pricing?: LLMPricing` signals "known but unpriced" models. Consumers updated (enrichment, registry, cost dispatcher).

  **Data quality**: Generated prices replace stale hand-typed entries. No pricing regressions; Anthropic, Mistral, Moonshot, Groq all carry live sync-derived values or documented placeholders.

- 5dcf711: Test: Replace exact entry count assertion with floor check to prevent blocking automated catalog sync PRs when providers add or remove models. Maintains defensive check against silent data loss while tolerating normal single-digit drift.
- 5dcc733: Fix missing bare Anthropic model IDs in context-windows generator. Some Anthropic model generations age out of the live /v1/models listing into dated-only IDs (e.g., `claude-opus-4-5-20251101`), but the bare "latest" spelling (e.g., `claude-opus-4-5`) remains a valid, callable back-compat ID. The pricing generator already derives these bare IDs from their dated siblings, but the context-windows generator was missing this logic, which dropped them from listNativeModelIds and every adapter's native model menu. Now derived identically to pricing.
- Updated dependencies [4b924c9]
- Updated dependencies [008a483]
- Updated dependencies [3496977]
- Updated dependencies [008a483]
- Updated dependencies [f0c51a7]
- Updated dependencies [001a2a0]
- Updated dependencies [5dcc733]
  - @agentproto/model-catalog@0.9.0

## 0.5.8

### Patch Changes

- Updated dependencies [95f7b5e]
- Updated dependencies [e826a4a]
- Updated dependencies [1fd4a15]
  - @agentproto/model-catalog@0.8.5

## 0.5.7

### Patch Changes

- Updated dependencies [7b28edf]
- Updated dependencies [e8d39e8]
  - @agentproto/model-catalog@0.8.4

## 0.5.6

### Patch Changes

- Updated dependencies [415044d]
  - @agentproto/model-catalog@0.8.3

## 0.5.5

### Patch Changes

- 6e1fcf3: Remove tilde-prefixed OpenRouter aliases and use non-throwing route resolution in widening
- Updated dependencies [2b58616]
- Updated dependencies [6e1fcf3]
  - @agentproto/model-catalog@0.8.2

## 0.5.4

### Patch Changes

- Updated dependencies [4b6bbe6]
  - @agentproto/model-catalog@0.8.1

## 0.5.3

### Patch Changes

- c825a12: Sync generated catalog data from the pinned provider sources.

  catalog-sync and runtime are named because their `src/__tests__` assertions
  had to follow the refreshed data (context-window entry count, gpt-5.6 tier
  repricing), and the coverage check counts anything under `src/` as
  publish-affecting.

- Updated dependencies [c825a12]
- Updated dependencies [980276e]
  - @agentproto/model-catalog@0.8.0

## 0.5.2

### Patch Changes

- 3088e23: catalog-sync: skip the Replicate image source's live refresh when `REPLICATE_API_TOKEN` is absent. The source now declares the token as an `env:REPLICATE_API_TOKEN` header, routing it through the runner's existing missing-env gate so it reuses the committed snapshot (like the authed LLM sources) instead of fetching unauthenticated, hitting 401, and crashing the whole `catalog-sync generate --refresh`.
- 1ea7682: Refresh provider-sourced model catalogs (OpenRouter, Requesty, HuggingFace, Moonshot, xAI) from live provider data: adds newly available models (e.g. claude-opus-5 and variants, gemini-3.5/3.6 entries) and updates pricing for existing entries. Data-only refresh via the existing catalog-sync generators; no adapter or routing logic changed.
- Updated dependencies [358af0e]
- Updated dependencies [f1484a4]
- Updated dependencies [0f10338]
- Updated dependencies [ec5f64f]
- Updated dependencies [1ea7682]
- Updated dependencies [42f1217]
  - @agentproto/model-catalog@0.7.0

## 0.5.1

### Patch Changes

- 9e30ad2: Refresh Moonshot/OpenRouter snapshots, add Kimi K3 + K2.7 Code pricing
- 5c99163: Sync docs (README/manifests) with already-shipped requesty preset, catalog-sync, and permissions watch
- Updated dependencies [9e30ad2]
  - @agentproto/model-catalog@0.6.0

## 0.5.0

### Minor Changes

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

### Patch Changes

- f392877: Sync docs with latest release features (interrupt, conversation_read, WORKTREE column, llm:context-windows, duration flags)
- Updated dependencies [719771e]
- Updated dependencies [9c2cec0]
  - @agentproto/model-catalog@0.5.0

## 0.4.0

### Minor Changes

- b531fd1: Add llm:context-windows generator and resolveContextWindow to model-catalog

### Patch Changes

- Updated dependencies [b531fd1]
  - @agentproto/model-catalog@0.4.0

## 0.3.0

### Minor Changes

- d924e95: Add route-identity subpath to model-catalog and refresh-workflow + OpenAI source to catalog-sync

### Patch Changes

- 7b53b8c: Relicense all packages from MIT to Apache-2.0
- Updated dependencies [1bdc055]
- Updated dependencies [afbf5c4]
- Updated dependencies [7b53b8c]
- Updated dependencies [d425044]
- Updated dependencies [d924e95]
  - @agentproto/model-catalog@0.3.0

## 0.2.0

### Minor Changes

- 7a310ff: New package: build-time model-catalog generators. `catalog-sync generate
[--refresh] [--check]` produces `*.generated.ts` catalog data from pinned
  provider snapshots (LLM via openrouter/models.dev; voice via
  elevenlabs/minimax; image via replicate). Catalog data becomes generated +
  reviewable, not hand-committed.

### Patch Changes

- fd03e5c: Add live-on-setup voice overlay and fix OpenRouter cache field names
- Updated dependencies [7a310ff]
- Updated dependencies [fd03e5c]
  - @agentproto/model-catalog@0.2.0

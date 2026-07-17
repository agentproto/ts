# @agentproto/catalog-sync

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

# @agentproto/catalog-sync

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

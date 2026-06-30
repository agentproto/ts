# @agentproto/catalog-sync

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

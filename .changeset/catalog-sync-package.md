---
"@agentproto/catalog-sync": minor
---

New package: build-time model-catalog generators. `catalog-sync generate
[--refresh] [--check]` produces `*.generated.ts` catalog data from pinned
provider snapshots (LLM via openrouter/models.dev; voice via
elevenlabs/minimax; image via replicate). Catalog data becomes generated +
reviewable, not hand-committed.

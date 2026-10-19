---
schema: app/v1
id: '@agentproto/model-catalog-watch'
name: Model Catalog Watch
version: 0.1.0
description: >-
  Daily sync + structured diff of the LLM pricing catalog (new/removed
  models, price changes, free<->paid transitions), with a free-model digest
  of what changed. Built on `scripts/catalog-sync/run-all.mjs` and the
  `catalog_diff` MCP tool (`@agentproto/model-intel`).
workflows:
  - id: watch
    path: .agentproto/workflows/watch/WORKFLOW.md
---

Daily sync + structured diff of the LLM pricing catalog, with a free-model
digest of what changed. See README.md for scope and the documented
limitation around event-triggering, and `routines/` for the scheduled
template.

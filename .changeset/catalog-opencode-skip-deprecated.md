---
"@agentproto/catalog-sync": patch
"@agentproto/model-catalog": patch
---

OpenCode Go/Zen route tables now drop models that models.dev flags `status: "deprecated"`. The endpoint no longer serves them (opencode's client hides them and a request answers "model not found"), but they stayed in the catalog and in profile allow-lists. The snapshot projection now keeps `status`, so regeneration stays deterministic.

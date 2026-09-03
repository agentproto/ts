---
"@agentproto/product": minor
"@agentproto/ref-catalog": minor
"@agentproto/extension": minor
---

Composable primitives foundation: add `@agentproto/ref-catalog` (AIP-54 — typed cross-AIP `ArtifactRef` + `aip://` URIs resolved through per-family AIP-43 registries via `RefCatalog`) and `@agentproto/product` (AIP-55 pricing capability — one-time / prepaid-pool / pay-per-call price union + billingRail attached to any artifact via an AIP-54 ref). `@agentproto/extension` gains AIP-40 v2 selective composition: `remove_fields` (guarded — parent-required fields refuse removal) and per-aspect `inherit: {schema, defaults, parse, path}`; omitted config reproduces v1 wholesale behavior exactly. Specs: `specs/resources/aip-54/draft/`, `specs/resources/aip-55/draft/` (rewritten to the capability shape), `specs/resources/aip-40/draft/` updated.

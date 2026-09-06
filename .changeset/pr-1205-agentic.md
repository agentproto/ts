---
"@agentproto/ref": minor
"@agentproto/product": minor
---

Consolidate `packages/ref-catalog` (AIP-54) back into `@agentproto/ref`, which now exports both the canonical `aip://` scheme (AIP-54) and the superseded `ws://` world scheme (AIP-27): `RefCatalog`, `refFor`, `refToUri`, `refFromUri`, `ArtifactRef`, and friends. `@agentproto/product` repoints its dependency accordingly and picks up two AIP-55 fixes: `defineProduct`'s `on` now also accepts the `aip://` URI string form (normalized + validated into `ref/v1`), and `collectPriced` reports dangling refs via `{resolved, dangling}` instead of silently dropping them.

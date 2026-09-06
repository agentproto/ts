# @agentproto/product

## 1.0.0

### Major Changes

- 5befe96: Merge `@agentproto/ref-catalog` (AIP-54) into `@agentproto/ref`. `@agentproto/ref` now
  also exports `RefCatalog`, `refFor`, `refToUri`, `refFromUri`, `ArtifactRef`,
  `RefFamilyError`, and `RefUnresolvableError` alongside its existing AIP-27 `agentref/v1`
  scheme. **`@agentproto/ref-catalog` is removed outright** — there is no forwarding shim;
  anyone depending on the previously-published `@agentproto/ref-catalog@0.2.0` must switch
  their imports to `@agentproto/ref`.

  `@agentproto/product` is repointed at the merged package and ships two AIP-55 fixes:
  - `defineProduct`'s `on` field now also accepts the `aip://` URI string form (normalized
    and validated the same way as the object form), not just an `ArtifactRef` object.
  - **Breaking:** `collectPriced` no longer silently drops products whose ref fails to
    resolve. It now returns `{ resolved, dangling }` instead of a bare array — `resolved`
    is the array of previously-returned `{ product, resolved }` pairs, and `dangling` lists
    every product whose ref did not resolve. Any caller destructuring the old array return
    (e.g. `collectPriced(...).length` or iterating the result directly) must update to
    `collectPriced(...).resolved`.

### Minor Changes

- 5befe96: Consolidate `packages/ref-catalog` (AIP-54) back into `@agentproto/ref`, which now exports both the canonical `aip://` scheme (AIP-54) and the superseded `ws://` world scheme (AIP-27): `RefCatalog`, `refFor`, `refToUri`, `refFromUri`, `ArtifactRef`, and friends. `@agentproto/product` repoints its dependency accordingly and picks up two AIP-55 fixes: `defineProduct`'s `on` now also accepts the `aip://` URI string form (normalized + validated into `ref/v1`), and `collectPriced` reports dangling refs via `{resolved, dangling}` instead of silently dropping them.

### Patch Changes

- Updated dependencies [5befe96]
- Updated dependencies [5befe96]
  - @agentproto/ref@0.2.0

## 0.2.0

### Minor Changes

- 89f6662: Composable primitives foundation: add `@agentproto/ref-catalog` (AIP-54 — typed cross-AIP `ArtifactRef` + `aip://` URIs resolved through per-family AIP-43 registries via `RefCatalog`) and `@agentproto/product` (AIP-55 pricing capability — one-time / prepaid-pool / pay-per-call price union + billingRail attached to any artifact via an AIP-54 ref). `@agentproto/extension` gains AIP-40 v2 selective composition: `remove_fields` (guarded — parent-required fields refuse removal) and per-aspect `inherit: {schema, defaults, parse, path}`; omitted config reproduces v1 wholesale behavior exactly. Specs: `specs/resources/aip-54/draft/`, `specs/resources/aip-55/draft/` (rewritten to the capability shape), `specs/resources/aip-40/draft/` updated.
- 89f6662: Add ref-catalog (AIP-54) and product (AIP-53) primitives with specs

### Patch Changes

- Updated dependencies [89f6662]
- Updated dependencies [89f6662]
  - @agentproto/ref-catalog@0.2.0

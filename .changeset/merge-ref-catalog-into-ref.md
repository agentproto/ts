---
"@agentproto/ref": minor
"@agentproto/product": major
---

Merge `@agentproto/ref-catalog` (AIP-54) into `@agentproto/ref`. `@agentproto/ref` now
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

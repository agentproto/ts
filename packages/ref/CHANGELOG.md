# @agentproto/ref

## 0.2.0

### Minor Changes

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

- 5befe96: Consolidate `packages/ref-catalog` (AIP-54) back into `@agentproto/ref`, which now exports both the canonical `aip://` scheme (AIP-54) and the superseded `ws://` world scheme (AIP-27): `RefCatalog`, `refFor`, `refToUri`, `refFromUri`, `ArtifactRef`, and friends. `@agentproto/product` repoints its dependency accordingly and picks up two AIP-55 fixes: `defineProduct`'s `on` now also accepts the `aip://` URI string form (normalized + validated into `ref/v1`), and `collectPriced` reports dangling refs via `{resolved, dangling}` instead of silently dropping them.

## 0.1.1

### Patch Changes

- f0c51a7: Weekly dependency bump: update 9 minor/patch dependencies to latest versions.
  - @anthropic-ai/claude-agent-sdk 0.3.241 → 0.3.251
  - @ast-grep/napi 0.45.2 → 0.45.3
  - @earendil-works/pi-tui 0.84.2 → 0.84.4
  - @tanstack/react-query 5.102.2 → 5.102.8
  - @testing-library/react 16.3.2 → 16.3.3
  - e2b 2.45.0 → 2.46.1
  - tsx 4.23.12 → 4.23.13
  - turbo 2.10.11 → 2.10.12
  - zod 4.4.3 → 4.5.4

  No code changes; pnpm-lock.yaml updated to reflect new dependency versions.

## 0.1.0

### Patch Changes

- 7b53b8c: Relicense all packages from MIT to Apache-2.0

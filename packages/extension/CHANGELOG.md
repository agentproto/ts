# @agentproto/extension

## 0.2.0

### Minor Changes

- 89f6662: Composable primitives foundation: add `@agentproto/ref-catalog` (AIP-54 — typed cross-AIP `ArtifactRef` + `aip://` URIs resolved through per-family AIP-43 registries via `RefCatalog`) and `@agentproto/product` (AIP-55 pricing capability — one-time / prepaid-pool / pay-per-call price union + billingRail attached to any artifact via an AIP-54 ref). `@agentproto/extension` gains AIP-40 v2 selective composition: `remove_fields` (guarded — parent-required fields refuse removal) and per-aspect `inherit: {schema, defaults, parse, path}`; omitted config reproduces v1 wholesale behavior exactly. Specs: `specs/resources/aip-54/draft/`, `specs/resources/aip-55/draft/` (rewritten to the capability shape), `specs/resources/aip-40/draft/` updated.

### Patch Changes

- @agentproto/define-doctype@0.1.1
- @agentproto/manifest@0.2.1

## 0.1.3

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

## 0.1.2

### Patch Changes

- 7b53b8c: Relicense all packages from MIT to Apache-2.0
- Updated dependencies [7b53b8c]
  - @agentproto/define-doctype@0.1.1
  - @agentproto/manifest@0.2.1

## 0.1.1

### Patch Changes

- Updated dependencies [1fc1750]
- Updated dependencies [1fc1750]
  - @agentproto/manifest@0.2.0

## 0.1.0

### Patch Changes

- Updated dependencies [44192c9]
  - @agentproto/manifest@0.1.0

# @agentproto/operator

## 0.2.0

### Minor Changes

- 6b78431: Accept the AIP-70 registry spec names on every read path and keep emitting the legacy tags for now. `@agentproto/governance` exports `SPEC_NAME = "governance/v1"` plus `LEGACY_SPEC_NAMES` and `EMITTED_SPEC_NAME`; the signature, audit-event, and policy schemas accept `governance/v1` and `agentgovernance/v1`, while newly signed artifacts, audit rows, and policy handles still carry `agentgovernance/v1` (it flips to the new name at the next major; old verifiers in the field only know the old tag, and the tag is part of the hashed audit-row bytes, so verification always uses the tag stored in the row). `@agentproto/operator` sets `SPEC_NAME = "operator/v1"` and its OPERATOR.md frontmatter enum now accepts `operator/v1` alongside the legacy `agentoperators/v1` and `agentoperator/v1`.

### Patch Changes

- 5ab8114: Switch the workspace dependents of the deprecated `@agentproto/define-doctype` shim to the canonical `@agentproto/doctype` package. Update dependency keys, import specifiers, tsup externals, and generated scaffolds; keep the shim and changelogs untouched.
- 5ab8114: Switch the workspace dependents of the deprecated `@agentproto/define-doctype` shim to the canonical `@agentproto/doctype` package: dependency keys, import specifiers, tsup externals, the lockfile, and the generated AIP scaffold. The shim itself and per-package changelogs are retained unchanged.
- Updated dependencies [8d8c10c]
- Updated dependencies [c6e0daa]
- Updated dependencies [f18edbc]
- Updated dependencies [c6e0daa]
- Updated dependencies [f18edbc]
  - @agentproto/doctype@0.2.0

## 0.1.5

### Patch Changes

- 74f982c: Weekly dependency refresh (minor/patch within declared ranges) across the workspace. `@agentproto/runtime` moves to defuddle 0.19, which lifts a title-like `<h1>` into `title` instead of leading `text`, affecting `fetch_page`/`browser_extract_text` output.
- 74f982c: Weekly dependency refresh: minor/patch bumps within declared ranges across the workspace. `@agentproto/runtime` moves to defuddle 0.19 (GHSA-jg4p-g6xj-4qmf); `fetch_page`/`browser_extract_text` now return a title-like `<h1>` in `title` rather than repeating it at the top of `text`.
- Updated dependencies [74f982c]
- Updated dependencies [74f982c]
  - @agentproto/define-doctype@0.1.4

## 0.1.4

### Patch Changes

- 444efc5: Accept the canonical AIP-9 spec tag `agentoperators/v1` (plural) in OPERATOR.md frontmatter, and make it the exported `SPEC_NAME`. The old singular `agentoperator/v1` is still accepted but deprecated.
- Updated dependencies [461df5e]
  - @agentproto/define-doctype@0.1.3

## 0.1.3

### Patch Changes

- c27f0b8: Weekly minor/patch dependency bumps across workspaces (zod, @mastra/*, react, yaml, claude-agent-sdk, etc.).

## 0.1.2

### Patch Changes

- 2f37e7b: Bump third-party dependency versions (weekly deps update)
- Updated dependencies [2f37e7b]
  - @agentproto/define-doctype@0.1.2

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
- Updated dependencies [7b53b8c]
  - @agentproto/define-doctype@0.1.1

# @agentproto/governance-engine

## 1.0.0

### Major Changes

- e301b84: Write the canonical AIP-70 `governance/v1` tag into new signature.json files and audit-log rows instead of `agentgovernance/v1`. Breaking for readers: files written by this version need @agentproto/governance-engine >= 0.2.0 and @agentproto/governance >= 0.2.0 to read. Existing legacy-tagged chains keep verifying because verification uses the tag stored in each row.

### Patch Changes

- Updated dependencies [e301b84]
  - @agentproto/governance@1.0.0
  - @agentproto/driver@0.4.1
  - @agentproto/tool@0.6.1

## 0.2.0

### Minor Changes

- 6b78431: Accept the AIP-70 registry spec names on every read path and keep emitting the legacy tags for now. `@agentproto/governance` exports `SPEC_NAME = "governance/v1"` plus `LEGACY_SPEC_NAMES` and `EMITTED_SPEC_NAME`; the signature, audit-event, and policy schemas accept `governance/v1` and `agentgovernance/v1`, while newly signed artifacts, audit rows, and policy handles still carry `agentgovernance/v1` (it flips to the new name at the next major; old verifiers in the field only know the old tag, and the tag is part of the hashed audit-row bytes, so verification always uses the tag stored in the row). `@agentproto/operator` sets `SPEC_NAME = "operator/v1"` and its OPERATOR.md frontmatter enum now accepts `operator/v1` alongside the legacy `agentoperators/v1` and `agentoperator/v1`.

### Patch Changes

- Updated dependencies [6b78431]
- Updated dependencies [9fbf379]
- Updated dependencies [d3dd524]
- Updated dependencies [5ab8114]
- Updated dependencies [5ab8114]
  - @agentproto/governance@0.2.0
  - @agentproto/driver@0.4.0
  - @agentproto/tool@0.6.0
  - @agentproto/ref@0.2.3

## 0.1.13

### Patch Changes

- 74f982c: Weekly dependency refresh (minor/patch within declared ranges) across the workspace. `@agentproto/runtime` moves to defuddle 0.19, which lifts a title-like `<h1>` into `title` instead of leading `text`, affecting `fetch_page`/`browser_extract_text` output.
- 74f982c: Weekly dependency refresh: minor/patch bumps within declared ranges across the workspace. `@agentproto/runtime` moves to defuddle 0.19 (GHSA-jg4p-g6xj-4qmf); `fetch_page`/`browser_extract_text` now return a title-like `<h1>` in `title` rather than repeating it at the top of `text`.
- Updated dependencies [74f982c]
- Updated dependencies [74f982c]
  - @agentproto/driver@0.3.3
  - @agentproto/governance@0.1.6
  - @agentproto/ref@0.2.3
  - @agentproto/tool@0.5.2

## 0.1.12

### Patch Changes

- Updated dependencies [ab367ec]
  - @agentproto/tool@0.5.1
  - @agentproto/driver@0.3.2

## 0.1.11

### Patch Changes

- Updated dependencies [5b021a8]
  - @agentproto/tool@0.5.0
  - @agentproto/driver@0.3.1

## 0.1.10

### Patch Changes

- Updated dependencies [a68d1d6]
- Updated dependencies [4243c75]
  - @agentproto/driver@0.3.0
  - @agentproto/tool@0.4.0

## 0.1.9

### Patch Changes

- Updated dependencies [461df5e]
  - @agentproto/ref@0.2.2
  - @agentproto/driver@0.2.5
  - @agentproto/governance@0.1.5
  - @agentproto/tool@0.3.2

## 0.1.8

### Patch Changes

- Updated dependencies [cd00daa]
  - @agentproto/driver@0.2.4

## 0.1.7

### Patch Changes

- c27f0b8: Weekly minor/patch dependency bumps across workspaces (zod, @mastra/*, react, yaml, claude-agent-sdk, etc.).
- Updated dependencies [c27f0b8]
  - @agentproto/driver@0.2.3
  - @agentproto/governance@0.1.4
  - @agentproto/ref@0.2.1
  - @agentproto/tool@0.3.1

## 0.1.6

### Patch Changes

- 2f37e7b: Bump third-party dependency versions (weekly deps update)
- Updated dependencies [5befe96]
- Updated dependencies [5befe96]
- Updated dependencies [2f37e7b]
- Updated dependencies [20ef731]
  - @agentproto/ref@0.2.0
  - @agentproto/driver@0.2.2
  - @agentproto/governance@0.1.3
  - @agentproto/tool@0.3.0

## 0.1.5

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

- Updated dependencies [f0c51a7]
  - @agentproto/driver@0.2.1
  - @agentproto/governance@0.1.2
  - @agentproto/ref@0.1.1
  - @agentproto/tool@0.2.2

## 0.1.4

### Patch Changes

- Updated dependencies [831d4f5]
- Updated dependencies [04aedad]
  - @agentproto/driver@0.2.0
  - @agentproto/governance@0.1.1

## 0.1.3

### Patch Changes

- 7b53b8c: Relicense all packages from MIT to Apache-2.0
- Updated dependencies [7b53b8c]
  - @agentproto/driver@0.1.3
  - @agentproto/governance@0.1.0
  - @agentproto/ref@0.1.0
  - @agentproto/tool@0.2.1

## 0.1.2

### Patch Changes

- Updated dependencies [78ac79e]
- Updated dependencies [dc870cf]
- Updated dependencies [2186e9e]
  - @agentproto/tool@0.2.0
  - @agentproto/driver@0.1.2

## 0.1.1

### Patch Changes

- Updated dependencies [1fc1750]
- Updated dependencies [1fc1750]
  - @agentproto/driver@0.1.1
  - @agentproto/tool@0.1.1

## 0.1.0

### Patch Changes

- Updated dependencies [44192c9]
  - @agentproto/driver@0.1.0
  - @agentproto/tool@0.1.0

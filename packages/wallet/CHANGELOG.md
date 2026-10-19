# @agentproto/wallet

## 0.2.0

### Minor Changes

- cb81038: AIP-49: add a generic `qualify` partition-policy rule. `{ kind: "qualify", key, allow }` makes a lot spendable only when the spend context's caller-asserted `qualifiers[key]` is one of `allow` (`"*"` = any value, qualifier still required). Fail-closed on a spend, neutral on a pure balance read, never changes quantity, and ANDs with `spendOn`/`expire`. `PolicyContext` gains optional `qualifiers`, and `spendableLotUnderPolicy` / `spendableBalanceUnderPolicy` accept an optional trailing `qualifiers` argument. The rule is accepted by `defineAsset`'s schema and the vendored `ASSET.schema.json`.
- cb81038: AIP-49: add a generic `qualify` partition-policy rule. `{ kind: "qualify", key, allow }` makes a lot spendable only when the spend context's caller-asserted `qualifiers[key]` is one of `allow` (`"*"` = any value, qualifier still required). It is fail-closed on a spend (a missing qualifier is ineligible), neutral on a pure balance read, never changes the quantity, and ANDs with `spendOn`/`expire`. `PolicyContext` gains optional `qualifiers`, and `spendableLotUnderPolicy` / `spendableBalanceUnderPolicy` accept an optional trailing `qualifiers` argument. The rule is accepted by `defineAsset`'s schema and vendored `ASSET.schema.json`.

### Patch Changes

- 74f982c: Weekly dependency refresh (minor/patch within declared ranges) across the workspace. `@agentproto/runtime` moves to defuddle 0.19, which lifts a title-like `<h1>` into `title` instead of leading `text`, affecting `fetch_page`/`browser_extract_text` output.
- 74f982c: Weekly dependency refresh: minor/patch bumps within declared ranges across the workspace. `@agentproto/runtime` moves to defuddle 0.19 (GHSA-jg4p-g6xj-4qmf); `fetch_page`/`browser_extract_text` now return a title-like `<h1>` in `title` rather than repeating it at the top of `text`.
- Updated dependencies [74f982c]
- Updated dependencies [74f982c]
  - @agentproto/define-doctype@0.1.4

## 0.1.4

### Patch Changes

- 461df5e: Package-metadata refresh accompanying the vendored-specs resync (PR #1554): homepage URLs and keyword tags renumbered to the ratified AIP numbers (app-kit/apps → AIP-53, mastra → AIP-52, define-doctype → AIP-56, wallet → AIP-49), a stale agentik.net homepage corrected (redaction), new keyword tags (pair-client → AIP-59, runtime → AIP-46/AIP-58), and test/doc-comment updates replacing the retired sandbox AIP-61 placeholder with a 9999 fixture number (product, ref), plus bundled SKILL.md renumbering (skill-pack-agentproto) and a routine doc comment aligned with the now-upstream `targetAgent` variant. No runtime behavior changes.
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

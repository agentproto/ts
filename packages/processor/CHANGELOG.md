# @agentproto/redaction

## 0.3.0

### Minor Changes

- dfb1aef: Rename `@agentproto/redaction` to the AIP-70 name `@agentproto/processor`, with a `@agentproto/redaction` shim that re-exports it unchanged.

## 0.2.4

### Patch Changes

- 74f982c: Weekly dependency refresh (minor/patch within declared ranges) across the workspace. `@agentproto/runtime` moves to defuddle 0.19, which lifts a title-like `<h1>` into `title` instead of leading `text`, affecting `fetch_page`/`browser_extract_text` output.
- 74f982c: Weekly dependency refresh: minor/patch bumps within declared ranges across the workspace. `@agentproto/runtime` moves to defuddle 0.19 (GHSA-jg4p-g6xj-4qmf); `fetch_page`/`browser_extract_text` now return a title-like `<h1>` in `title` rather than repeating it at the top of `text`.

## 0.2.3

### Patch Changes

- 461df5e: Package-metadata refresh accompanying the vendored-specs resync (PR #1554): homepage URLs and keyword tags renumbered to the ratified AIP numbers (app-kit/apps → AIP-53, mastra → AIP-52, define-doctype → AIP-56, wallet → AIP-49), a stale agentik.net homepage corrected (redaction), new keyword tags (pair-client → AIP-59, runtime → AIP-46/AIP-58), and test/doc-comment updates replacing the retired sandbox AIP-61 placeholder with a 9999 fixture number (product, ref), plus bundled SKILL.md renumbering (skill-pack-agentproto) and a routine doc comment aligned with the now-upstream `targetAgent` variant. No runtime behavior changes.

## 0.2.2

### Patch Changes

- 2f37e7b: Bump third-party dependency versions (weekly deps update)

## 0.2.1

### Patch Changes

- 7b53b8c: Relicense all packages from MIT to Apache-2.0

## 0.2.0

### Minor Changes

- 5b9b5ec: Add @agentproto/redaction: dependency-free Redactor port, deny-list/truncate/none built-ins, chainRedactors, and catalog resolver
- bd4d7a0: Add value-scan redactor and secrets slug; bump runtime default tracer to secrets

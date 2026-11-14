# @agentproto/define-doctype

## 0.2.0

### Minor Changes

- c6e0daa: Export each package's AIP-70 registry spec id as `SPEC_NAME`, and make `check-names` flag registered packages that export none.
- f18edbc: Rename the doctype meta-factory to its AIP-70 canonical name `@agentproto/doctype`, moving the implementation unchanged. `@agentproto/define-doctype` is kept as a deprecated shim that re-exports the new package so existing importers keep working; the workspace STATUS/spec-reference classification and tests are updated for both names.
- c6e0daa: Export each package's AIP-70 registry spec id as `SPEC_NAME`, and make `check-names` flag registered packages that export no `SPEC_NAME`/`SPEC_ID` constant (mirrors `.changeset/e33-spec-name-constants.md`).
- f18edbc: Rename the doctype meta-factory to its AIP-70 name `@agentproto/doctype`, and keep `@agentproto/define-doctype` as a deprecated shim that re-exports it unchanged.

### Patch Changes

- 8d8c10c: Release and doc hygiene after the AIP-70 renames: fix remaining old package
  names and dead paths, add the missing harness and doctype READMEs, document
  the `inference-endpoint` command alongside its `llm-endpoint` alias, and
  classify the AIP-70 rename shims as archived in STATUS.md.

## 0.1.4

### Patch Changes

- 74f982c: Weekly dependency refresh (minor/patch within declared ranges) across the workspace. `@agentproto/runtime` moves to defuddle 0.19, which lifts a title-like `<h1>` into `title` instead of leading `text`, affecting `fetch_page`/`browser_extract_text` output.
- 74f982c: Weekly dependency refresh: minor/patch bumps within declared ranges across the workspace. `@agentproto/runtime` moves to defuddle 0.19 (GHSA-jg4p-g6xj-4qmf); `fetch_page`/`browser_extract_text` now return a title-like `<h1>` in `title` rather than repeating it at the top of `text`.

## 0.1.3

### Patch Changes

- 461df5e: Package-metadata refresh accompanying the vendored-specs resync (PR #1554): homepage URLs and keyword tags renumbered to the ratified AIP numbers (app-kit/apps → AIP-53, mastra → AIP-52, define-doctype → AIP-56, wallet → AIP-49), a stale agentik.net homepage corrected (redaction), new keyword tags (pair-client → AIP-59, runtime → AIP-46/AIP-58), and test/doc-comment updates replacing the retired sandbox AIP-61 placeholder with a 9999 fixture number (product, ref), plus bundled SKILL.md renumbering (skill-pack-agentproto) and a routine doc comment aligned with the now-upstream `targetAgent` variant. No runtime behavior changes.

## 0.1.2

### Patch Changes

- 2f37e7b: Bump third-party dependency versions (weekly deps update)

## 0.1.1

### Patch Changes

- 7b53b8c: Relicense all packages from MIT to Apache-2.0

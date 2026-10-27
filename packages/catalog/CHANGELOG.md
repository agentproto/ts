# @agentproto/catalog

## 0.2.0

### Minor Changes

- 8aa0aeb: Add an internal data-format id (`CATALOG_FORMAT`, `CORPUS_FORMAT`, `EVAL_FORMAT`), removing the packages' claims to be AIP registry specs. The legacy `SPEC_NAME` export is retained for compatibility and is now deprecated; it remains a legitimate pending registry-name deviation until it is removed.

## 0.1.2

### Patch Changes

- 74f982c: Weekly dependency refresh (minor/patch within declared ranges) across the workspace. `@agentproto/runtime` moves to defuddle 0.19, which lifts a title-like `<h1>` into `title` instead of leading `text`, affecting `fetch_page`/`browser_extract_text` output.
- 74f982c: Weekly dependency refresh: minor/patch bumps within declared ranges across the workspace. `@agentproto/runtime` moves to defuddle 0.19 (GHSA-jg4p-g6xj-4qmf); `fetch_page`/`browser_extract_text` now return a title-like `<h1>` in `title` rather than repeating it at the top of `text`.

## 0.1.1

### Patch Changes

- 2f37e7b: Bump third-party dependency versions (weekly deps update)

## 0.1.0

### Patch Changes

- 7b53b8c: Relicense all packages from MIT to Apache-2.0

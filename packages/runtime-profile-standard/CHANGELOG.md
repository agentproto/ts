# @agentproto/runtime-profile-standard

## 0.1.4

### Patch Changes

- 74f982c: Weekly dependency refresh (minor/patch within declared ranges) across the workspace. `@agentproto/runtime` moves to defuddle 0.19, which lifts a title-like `<h1>` into `title` instead of leading `text`, affecting `fetch_page`/`browser_extract_text` output.
- 74f982c: Weekly dependency refresh: minor/patch bumps within declared ranges across the workspace. `@agentproto/runtime` moves to defuddle 0.19 (GHSA-jg4p-g6xj-4qmf); `fetch_page`/`browser_extract_text` now return a title-like `<h1>` in `title` rather than repeating it at the top of `text`.

## 0.1.3

### Patch Changes

- 2f37e7b: Bump third-party dependency versions (weekly deps update)

## 0.1.2

### Patch Changes

- 7b53b8c: Relicense all packages from MIT to Apache-2.0

## 0.1.1

### Patch Changes

- 2d3038c: Fix run-swarm role paths, claude permission hang, and per-participant model config

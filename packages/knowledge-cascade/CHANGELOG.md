# @agentproto/knowledge-cascade

## 0.2.7

### Patch Changes

- @agentproto/corpus@0.8.4

## 0.2.6

### Patch Changes

- 74f982c: Weekly dependency refresh (minor/patch within declared ranges) across the workspace. `@agentproto/runtime` moves to defuddle 0.19, which lifts a title-like `<h1>` into `title` instead of leading `text`, affecting `fetch_page`/`browser_extract_text` output.
- 74f982c: Weekly dependency refresh: minor/patch bumps within declared ranges across the workspace. `@agentproto/runtime` moves to defuddle 0.19 (GHSA-jg4p-g6xj-4qmf); `fetch_page`/`browser_extract_text` now return a title-like `<h1>` in `title` rather than repeating it at the top of `text`.
- Updated dependencies [74f982c]
- Updated dependencies [74f982c]
  - @agentproto/corpus@0.8.3

## 0.2.5

### Patch Changes

- Updated dependencies [aa5e4bd]
- Updated dependencies [e8fc640]
  - @agentproto/corpus@0.8.2

## 0.2.4

### Patch Changes

- @agentproto/corpus@0.8.1

## 0.2.3

### Patch Changes

- Updated dependencies [c27f0b8]
- Updated dependencies [f94b632]
  - @agentproto/corpus@0.8.0

## 0.2.2

### Patch Changes

- @agentproto/corpus@0.7.3

## 0.2.1

### Patch Changes

- 2f37e7b: Bump third-party dependency versions (weekly deps update)
- Updated dependencies [2f37e7b]
  - @agentproto/corpus@0.7.2

## 0.2.0

### Minor Changes

- 4210682: New library for composing file layers with override/extend/whiteout semantics. Provides `DiskFs` (node:fs-backed FsPort), `packFs` (read-only pack wrapper), and `mountCascade` (layer composition) for standalone apps and services to mount a global knowledge pack shadowed by per-scope overrides.

### Patch Changes

- Updated dependencies [f9e21fd]
  - @agentproto/corpus@0.7.1

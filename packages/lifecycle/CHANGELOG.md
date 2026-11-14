# @agentproto/lifecycle

## 0.2.0

### Minor Changes

- ba7e5a1: Reconcile the action-hooks/v1 contract with AIP-71 and AIP-37: rename the contract id from hooks/v1, add the harness extension event names, and attach stable error codes to HooksContractError. No runtime behavior is added.
- bee10e3: Add the hooks/v1 contract types and validation for AIP-37 event refs, AIP-39 action refs, AIP-42 `on:` maps, and host event registrations. No runtime dispatcher is wired.
- d3dd524: Align `SPEC_NAME` with the canonical AIP-70 names registry, add the `defineAuth` alias for `defineAuthProvider`, and point the runtime approval request at the accepted AIP-7.
- bee10e3: Add the hooks/v1 contract types and parsers for AIP-37 event refs, AIP-39 action refs, AIP-42 `on:` maps, and explicit host event registrations. This is contract-only: no dispatcher, scheduler, receipt store, or runtime behavior is added, and existing lifecycle exports are preserved.

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

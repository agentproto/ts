# @agentproto/catalog

## 1.0.0

### Major Changes

- e301b84: Remove the pre-AIP-70 leftovers: deprecated `SPEC_NAME` exports, the `definePack`/`Pack` model-routing aliases, the runtime re-exports of symbols owned by extracted packages, and the `inference-endpoint` compatibility bin. Import those symbols from their owning packages and use `defineRoutingPack`/`RoutingPack` for model-routing packs.
- e301b84: Remove the pre-AIP-70 aliases (`SPEC_NAME` exports, `definePack`/`Pack`, runtime re-exports, the duplicate `llm-endpoint` bin) and centralize the Anthropic unified rate-limit parser in `@agentproto/quota`. The CLI `review verify` path and the runtime review ledger and compose paths now treat `agentproto-pack-digest/v1` and `review.pack-digest/v1` as the same digest recipe, so attestations written with either tag compare correctly.

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

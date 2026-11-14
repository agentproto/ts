# @agentproto/quota

## 0.3.0

### Minor Changes

- 7811321: `quota_status` now reads Anthropic subscription profiles (`anthropic` / `oauth-bearer`) instead of answering `no_reader`. A new `createAnthropicOAuthQuotaReader` sends one `max_tokens: 1` Messages request with the profile's keychain OAuth token and turns the `anthropic-ratelimit-unified-<window>-utilization` / `-reset` reply headers into windows (`5h`, `7d`, any per-model id the provider sends) with `remainingPct` and `resetsAt`; a window the provider omits is absent, never zero. Basis is `probe`. Failures are explicit instead of `reader_returned_nothing`: `credential_missing`, `credential_rejected`, `rate_limited`, `provider_unreachable`, carried by the new optional `QuotaReadContext.reportFailure`; messages cite the keychain key name, never the token.

## 0.2.0

### Minor Changes

- e301b84: Remove the pre-AIP-70 aliases (`SPEC_NAME` exports, `definePack`/`Pack`, runtime re-exports, the duplicate `llm-endpoint` bin) and centralize the Anthropic unified rate-limit parser in `@agentproto/quota`. The CLI `review verify` path and the runtime review ledger and compose paths now treat `agentproto-pack-digest/v1` and `review.pack-digest/v1` as the same digest recipe, so attestations written with either tag compare correctly.
- e301b84: Move the Anthropic unified rate-limit header parser into `@agentproto/quota` and have the runtime remaining-quota reader use it. The CLI now imports the sentinel view type from `@agentproto/sentinel` instead of the runtime re-export.

## 0.1.0

### Minor Changes

- 449ab6f: Move the AIP-67 quota API to the new `@agentproto/quota` package. `@agentproto/model-intel` keeps `diffCatalog` and re-exports the quota API as deprecated aliases; `@agentproto/runtime` imports quota symbols from `@agentproto/quota`.

---
"@agentproto/quota": minor
"@agentproto/runtime": minor
---

`quota_status` now reads Anthropic subscription profiles (`anthropic` / `oauth-bearer`) instead of answering `no_reader`. A new `createAnthropicOAuthQuotaReader` sends one `max_tokens: 1` Messages request with the profile's keychain OAuth token and turns the `anthropic-ratelimit-unified-<window>-utilization` / `-reset` reply headers into windows (`5h`, `7d`, any per-model id the provider sends) with `remainingPct` and `resetsAt`; a window the provider omits is absent, never zero. Basis is `probe`. Failures are explicit instead of `reader_returned_nothing`: `credential_missing`, `credential_rejected`, `rate_limited`, `provider_unreachable`, carried by the new optional `QuotaReadContext.reportFailure`; messages cite the keychain key name, never the token.

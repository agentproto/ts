---
"@agentproto/runtime": minor
"@agentproto/cli": patch
---

**@agentproto/runtime:** Adds the `webhook` push sentinel provider (AIP-60 §5): one refcounted GitHub repo hook per repo pointing at `POST /inbound/sentinel-<hookKey>`, HMAC-gated and delivered through a new `SentinelRuntime.deliverPushed()` path that reuses the poll pipeline (seen-dedup, match, `until`). Also adds public-URL resolution (`AGENTPROTO_PUBLIC_URL` / stable-tunnel detection), an optional `readiness()` probe on `SentinelProviderHandle` surfaced by `list_sentinel_adapters`, a new exported `deliveryPreferenceFor()` helper, and provider auto-select in `createSentinelWatch` (push fields on `DeliveryPreference` are now optional).

**@agentproto/cli:** Updates `sentinel watch` help text for the new `webhook` provider option and its auto-select default.

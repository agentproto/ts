---
"@agentproto/runtime": minor
---

Sentinel webhook target end-to-end: unfreeze `target:{kind:"webhook"}` in
`SentinelStore` (sidecar secret rows with `prevSecret`/`rotatedAt` for the
10-min dual-sign rotation window), persisted webhook outbox
(`sentinel-webhook-outbox.ts`) with ack-after-terminal dispatch, restart
resume by exact bytes, expiry gates + sweep, and 24h reaping; the REST twin
`POST /sentinels` accepts the webhook target; `sentinelView` redacts webhook
secrets on every listing/get view.

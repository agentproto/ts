---
"@agentproto/runtime": minor
---

`agent_start` (and `POST /sessions/agent`) accepts an optional `notifySecret` (`whsec_...`) alongside `notifyUrl`: when set, every session-event webhook POST (turn-end/awaiting-input/exited) is signed with Standard Webhooks headers (`webhook-id`/`webhook-timestamp`/`webhook-signature`, HMAC-SHA256), reusing the existing `webhook-egress/signing.ts` contract. The global notify target (`~/.agentproto/notify.json` or `AGENTPROTO_NOTIFY_URL`) gains a matching optional `secret` field / `AGENTPROTO_NOTIFY_SECRET` env var. A target with no secret is posted exactly as before — unauthenticated, `Content-Type` only — so every existing caller sees zero behavior change.

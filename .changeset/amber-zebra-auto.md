---
"@agentproto/runtime": patch
---

An AIP-53 link token is now reusable until its own `exp`: a second `POST /apps/:appId/link-auth` with the same link token and fresh valid Telegram `initData` succeeds (a second tap on a Telegram button, a webview reload, a silent re-auth), where it used to answer 401 "this link has already been used". Every other check is unchanged: signature and expiry, the Telegram-gated requirement, `initData` validation (300 s max age, signed for the claimed user), the user-mismatch 403, per-attempt audit logging, and the session token TTL with its 24 h cap.

---
"@agentproto/runtime": minor
"@agentproto/cli": patch
---

Surface in-band turn errors end-to-end: a turn whose adapter stream ends after an `error` event (no explicit turn-end) is now classified `reason: "error"` instead of `"exited"`. Adds `SessionTurnEndEvent.error`, `SessionWaitResult.error`, `lastTurnErrorMessage` on the descriptor/compact list projection, and forwards `reason`/`error` on webhook payloads; `sessions wait` and `session_monitor` diagnostics fold in the captured message.

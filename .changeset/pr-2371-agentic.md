---
"@agentproto/runtime": minor
---

`defaults.identity.sessionTokens` gains `"enforce"`: invalid tokens, mismatching claims and claim-only callers naming a token-delivered session are refused (403 `identity_unverified` / `identity_mismatch`), `GET /identity` reports refusals and splits `claim_only` by class, and the default stays `"shadow"`. A session caller can also no longer write `defaults.messaging.*`, `defaults.identity.*` or `defaults.tasks.operatorDelegates` through `config_set` or `PATCH /config` (`operator_only`).

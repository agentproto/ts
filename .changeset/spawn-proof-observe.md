---
"@agentproto/runtime": minor
---

Spawn proof counters are now on `GET /identity` under `spawnProof`: verdict counts, the `claimed` split by whether a token was deliverable, `wouldRefuse`, `refused` and `requireProofIgnored`. The new `defaults.identity.requireProof` (default empty) refuses a claimed or mismatching session spawning with `identity_unverified` or `identity_mismatch`; it is ignored while `sessionTokens` is `"off"`. The delegation, auth-profile and stdio mount gates now also see a session spawning over the HTTP routes (`POST /sessions/agent`, `POST /sessions/chat`) instead of reading `no_caller`.

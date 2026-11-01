---
"@agentproto/runtime": minor
---

Add the opt-in AIP-46 spawn proof gate and always-on `spawnProof` counters. `defaults.identity.requireProof` (default empty, `session:spawn` only) refuses a claimed caller with `identity_unverified` and a token minted for another session with `identity_mismatch`; the list is ignored while `sessionTokens` is `"off"`. `GET /identity` now reports `spawnProof` verdict counts, the `claimed` split by token deliverability, `wouldRefuse`, `refused`, `requireProofIgnored` and the listed actions. HTTP spawns now carry their trusted caller id into the delegation, auth-profile and stdio-mount gates instead of reading `no_caller`. This complements `.changeset/spawn-proof-observe.md`.

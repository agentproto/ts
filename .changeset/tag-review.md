---
"@agentproto/review": major
---

Emit the canonical AIP-70 tags `review.attestation/v1` (attestation `schema`) and `review.pack-digest/v1` (`PackDigest.alg`) instead of `agentproto.review.attestation/v1` and `agentproto-pack-digest/v1`. Breaking for readers: files written by this version need @agentproto/review >= 0.7.0 to read, and the pack digest `alg` is compared strictly by earlier @agentproto/cli (`review verify`) and @agentproto/runtime (review ledger and compose), which need the releases that ship with this change to read it. Readers of this version still accept the legacy tags. Adds `LEGACY_PACK_DIGEST_ALG` and `normalizePackDigestAlg`.

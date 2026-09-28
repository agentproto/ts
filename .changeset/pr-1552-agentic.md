---
"@agentproto/review": minor
"@agentproto/cli": patch
"@agentproto/runtime": patch
"@agentproto/review-pack-core": patch
---

@agentproto/review: version the pack digest recipe — `PackDigest` gains a required `alg` field (`"agentproto-pack-digest/v1"`), and the recipe is factored into a new exported `computePackDigestSha256` with `PACK_DIGEST_ALG` constant; the exact byte layout is now documented. @agentproto/cli: `review verify` now hard-fails (not a skip note) when a pack's attested digest `alg` is unrecognized, before comparing digests. @agentproto/runtime and @agentproto/review-pack-core: test updates and description wording only.

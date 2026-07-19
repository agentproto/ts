---
"@agentproto/workspace": patch
---

Republish `@agentproto/workspace` to carry the AIP-34 optional-home-workspace
change (#468) that landed in source but was never released.

`@agentproto/workspace@0.1.0` on npm predates #468: the feature merged without a
changeset bumping this package, leaving the npm tarball stale under the same
version. No published dependent imports the new surface (unlike the fatal
auth↔cli skew), so this is a latent correctness fix rather than an active break
— but it closes the same publish-skew gap.

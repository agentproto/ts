---
"@agentproto/review": minor
"@agentproto/runtime": minor
"@agentproto/cli": minor
"@agentproto/apps": minor
---

Review attestation signing and composition: `@agentproto/review` gains `canonicalJson`, `canonicalAttestationBytes`, and `attestationSha256` plus optional `Attestor.signature` and `LaneResult.composedFrom` fields. `@agentproto/runtime` adds `review-signing.ts` (SSH-keygen-based `signAttestation`/`verifySignedAttestation`, key management, `ReviewConfig`) and `review-compose.ts` (delta re-review composition). `@agentproto/cli` adds the `review key` subcommand and `verify --allowed-signers/--require-signed` (exit code 6). The review panel shows signed/unsigned badges.
